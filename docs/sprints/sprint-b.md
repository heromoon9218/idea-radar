# Sprint B: 起草/スコアリングの構造追加（完了）

> 実装済み。2026-04-23 に PR #31 で実装提出、migration 適用後 main にマージ予定。  
> evergreen な仕様は [`../../SPEC.md`](../../SPEC.md) を参照。

Sprint A の定量化 + 帯別重み付けで「精度の底」は上がった。Sprint B はその上で **「起草と採点に構造的な反証と追加観点を入れる」** フェーズ。LLM コストがやや増える (Top 10 への追加呼び出し) ため、効果を見ながら段階的に入れる。

---

## B-1: Devil's advocate 2-pass スコアリング

- Sonnet 初回スコア後、別呼び出しで「このアイデアを却下すべき 3 つの理由」を生成し、それを踏まえて再スコアする 2-pass 構成
- 甘めに振れる採点を締める定番手法。Top 10 のみ適用すればコスト増は限定的
- 実装: `src/analyzers/sonnet-devils-advocate.ts` を追加し、`scoreIdea` 後に `critiqueAndRescore(scored)` を通す。reasoning を `ideas.devils_advocate` jsonb に保持して後続検証に使えるようにする

---

## B-2: 赤旗スキャン役割

- 既存 3 役割はポジティブ発想。法規制・API 利用規約・データ取得正当性の「地雷」を拾う役割が無い
- 追加する観点:
  - 薬機法 (SaMD 該当性)、金商法、資金決済法、景表法
  - スクレイピング禁止 API / 二要素認証越え
  - 医療・金融の誤った安心感 (倫理リスク)
- 実装: `src/analyzers/sonnet-risk-auditor.ts` を 4 番目の役割として追加。起草直後 (スコアリング前) に通して `ideas.risk_flags` に構造化して保持。赤旗ありでも除外はせず、deliver 側で「⚠️ 薬機法リスク: SaMD 該当性」等として Markdown に警告表示する
- Tavily で「薬機法 ガイドライン 2024」等を裏取りする経路を持たせるかは B-4 のクエリ多角化と合わせて判断

---

## B-3: フェルミ推定の必須化

- 現状のアイデアには「どれくらい売れるか」の定量見積もりがなく、reality check が効いていない
- 各アイデアに「TARGET_MRR 到達に必要な顧客数 × 想定 ARPU × 継続月数」のフェルミ推定を必須化 (例: 買い切り 3,000 円 × 月 17 本で月 5 万円)
- 実装: drafter 3 役割の出力スキーマ (`HaikuIdeaCandidateSchema`) に `fermi_estimate: { unit_price, unit_type, mrr_formula }` を追加。推定不可能なアイデアは drafter が自主的に除外 (raw_score を下げる) する運用
- Markdown 表記に「月 5 万円到達: 買い切り 3,000 円 × 月 17 本」等の 1 行を追加

---

## B-4: 検索クエリの多角化

- 現状 Tavily は `title + category_en` の英語 1 クエリのみ。日本市場の競合検出精度が弱い
- 改善: 以下 2-3 本を並列で投げて結果を union
  - 英語: `title + category_en` (現行)
  - 日本語: `title`（日本語）+ 「競合」「類似サービス」
  - 機能ワード: `what` から主要機能を 1-2 語抽出 + 英語
- Tavily 無料枠 1,000 req/月の範囲内に収まるよう、Top 10 × 2-3 クエリ = 月 600-900 req で試算
- 実装: `src/lib/tavily.ts` に `searchParallel(queries)` を追加、`analyze.ts` の `scoreTopCandidates` から呼ぶ

---

## Sprint B 完了基準（外部観察可能）

- [x] Top 10 のアイデアに Devil's advocate 2-pass が適用され、ideas テーブルに却下理由が保持される
- [x] 薬機法 / API 利用規約等のリスクがあるアイデアに `risk_flags` が付き、Markdown に警告表示される
- [x] 全アイデアがフェルミ推定を含み、Markdown に「月 5 万円到達: ...」行が出る
- [x] Tavily クエリが 2-3 本並列で投げられ、日本語競合が拾えるようになる
- [x] LLM + Tavily 月コスト増が $10 以下に収まる (実測予測 ~$6/月)

**本番反映手順**:
1. Supabase 本番で `supabase/migrations/20260510000000_ideas_sprint_b.sql` を apply (新列が無いと analyze の insert が失敗)
2. 通常どおり collect → analyze → deliver
