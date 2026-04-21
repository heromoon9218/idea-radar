# IdeaRadar Personal — 仕様書

## 概要

個人開発で **月 ¥10k の収益** に到達するための「作るべきもの」を日次で発掘する自分用ツール。日本語圏のエンジニア向け情報ソース (Hacker News / Zenn / はてなブックマーク) から「痛み」「愚痴」「ニーズ」を自動収集し、LLM で構造化・スコアリングした個人開発アイデア Top 3〜5 件を **JST 朝 8:30 の 1 日 1 回、自分宛メール** で配信する。

## 目的と評価軸

「作ってみたい度」ではなく、以下を主評価軸に置く：

- **非エンジニアまたは B2B 小口が金を払う可能性があるか** — 「開発者向け無料 DevTool」では ¥10k/月 に届きにくいため、需要検証済み・課金文化あり・競合ニッチ な領域を優先する
- **ソロ開発者が競合に埋もれずに入り込めるか** — 1〜3 ヶ月で MVP を出せる規模、かつ既存大手が手を出しにくい隙間であること
- **既に金が動いているドメインの「隙間」であるか** — 新規需要の創造より、既存需要の未充足ポイントを狙う

### 現在の情報源バイアスと緩和策

本ツールの 3 ソース (HN / Zenn / はてブ) は読者層が開発者中心で、「自作できる・無料志向」の層が多い。そのまま痛みシグナルとして採用すると DevTool / OSS 的アイデアに偏り、目的から外れやすい。この偏りの緩和策：

- **Show / Ask / Launch HN の分類タグ** (実装済み): 「自作プロダクト告知・具体的課題質問・YC ローンチ」を優先シグナルとして識別し、Haiku クラスタリング時に gap_candidates 側に流れやすくする
- **HN normal のノイズフィルタ** (実装済み): HN 通常投稿 (Show/Ask/Launch/Tell プリフィックスなし) は 24h で 400+ 件発生するがほとんどが score 1-2 のままフィードから消えるため、収集時に HN score 上位 100 件のみ採用。日次収集量を ~638 件から ~313 件に抑え、analyze の 500 件上限に収まるようにする
- **Sonnet × 3 役割のアイデア創出** (S2 実装): 集約者は「複数シグナルで裏取れた痛み」に集中し、結合者は「痛み × 技術の掛け合わせ」、隙間発見者は「既存プロダクト告知の穴・隣接ドメイン移植・非エンジニア向け化」を担う。1 役割が DevTool に偏っても他役割で補正する構造的バイアス低減
- **将来の情報源拡張候補**: Indie Hackers milestones / Product Hunt / App Store & Steam ランキング / 既存サービスの低評価レビュー — 「既に金が動いている領域の隙間」が観察できるソース群
- **スコアリング軸の段階的再定義**: `market_score` / `competition_score` を非エンジニア視点・B2B 小口視点に寄せる

## スコープ

- **完全に自分用**（SaaS 化しない、マルチユーザー対応なし、認証・課金・LP すべて不要）
- **運用コスト最小化**: 月 **$10〜24** 目安（LLM API のみ、1 日 1 回配信）
- **成功指標（段階的）**:
  - **短期 (〜3 ヶ月)**: 月 1 件以上、**実装着手したい** と判断できるアイデアが届く
  - **中期 (〜6 ヶ月)**: このパイプライン起点で着手したプロジェクトから **初の有料ユーザー** が出る
  - **長期 (〜12 ヶ月)**: このパイプライン起点のプロジェクト 1 本が **月 ¥10k の収益** に到達する

## 技術構成

### 実行基盤
- **GitHub Actions**（プライベートリポジトリ想定）
  - 収集ワークフロー: `cron: '0 22 * * *'`（UTC 22:00 = JST 翌朝 7:00、1 日 1 回）
  - 分析ワークフロー: `cron: '0 23 * * *'`（UTC 23:00 = JST 翌朝 8:00、1 日 1 回 / timeout 15min）
  - 配信ワークフロー: `cron: '30 23 * * *'`（UTC 23:30 = JST 翌朝 8:30、1 日 1 回 / 分析完了から 15min のマージン）

### スタック
- **言語**: Node.js 20+ / TypeScript
- **DB**: Supabase Postgres（無料枠 500MB）
- **LLM**:
  - Claude Haiku: シグナルのクラスタリング（日次、大量処理）
  - Claude Sonnet: アイデア創出（3 役割並列 / 日次）+ スコア精査（日次、少量のみ）
- **メール配信**: Resend（無料枠 100 通/日）
- **競合検索**: Tavily Search API（無料枠 1,000 req/月 / Brave は 2026-02 に Free 廃止のため乗り換え）

## データソース（全て無料 API / RSS）

| ソース | 取得方法 | 備考 |
|-------|---------|------|
| はてなブックマーク | Hotentry RSS / カテゴリ RSS | IT カテゴリ中心 |
| Zenn | 公式 API | 記事・トレンド |
| Hacker News | Firebase API | Top / Ask HN |

**除外したソース**:
- **X（Twitter）**: 公式 API が月 $100 で無料化と両立不可
- **Reddit / Product Hunt**: 認証（OAuth / 開発者トークン）運用コストが高い割に日本語圏のシグナル密度が低いため初期スコープから除外
- いずれも将来必要になった時点で再検討

## データベーススキーマ（概要）

### `raw_signals`（生データ）
- `id` (uuid, pk)
- `source` (enum: hatena / zenn / hackernews)
- `external_id` (text, ソース内 ID、重複チェック用)
- `url` (text)
- `title` (text)
- `content` (text)
- `author` (text)
- `posted_at` (timestamptz)
- `collected_at` (timestamptz)
- `metadata` (jsonb, ソース固有の追加情報)
- UNIQUE(source, external_id)

### `ideas`（構造化済みアイデア）
- `id` (uuid, pk)
- `title` (text, アイデアタイトル)
- `why` (text, 誰のどんな痛みか: ターゲット + 状況)
- `what` (text, 何を作るか: プロダクト概要 + 差別化 + 収益モデル)
- `how` (text, どう実現するか: 技術スタック + MVP 構成 + 実装難度)
- `category` (enum: dev-tool / productivity / saas / ai / other)
- `market_score` (int, 1-5, 市場性)
- `tech_score` (int, 1-5, 技術難度の低さ)
- `competition_score` (int, 1-5, 競合の少なさ)
- `total_score` (int, 上記3軸の合計)
- `competitors` (jsonb, 類似サービスのリスト)
- `source_signal_ids` (uuid[], raw_signals への参照)
- `created_at` (timestamptz)
- `delivered_at` (timestamptz, null if not yet sent)

### `reports`（配信ログ）
- `id` (uuid, pk)
- `date` (date)
- `slot` (enum: am / pm, 朝配信 or 夜配信)
- `idea_ids` (uuid[])
- `email_sent_at` (timestamptz)
- `resend_id` (text)
- UNIQUE(date, slot)

## 機能

### 収集層（S1 で実装）
- 各ソースから**過去 6 時間の新規投稿のみ**取得（取りこぼし防止で実際は 370 分ウィンドウ）
- `raw_signals` に UNIQUE 制約で重複除外挿入
- 失敗時は GitHub Actions の通知（メール or Issue）

### 分析層（S2 で実装）

淡白なアイデアを避けるため、**ハッカソンで 3 人がブレストするイメージ**で Sonnet × 3 役割がそれぞれ異なる発想法でアイデアを起草する。

**パイプライン:**
1. 直近 24 時間の `raw_signals` から未処理分を Haiku に投げ、**クラスタリング**する
   - Haiku はアイデア文を書かない。シグナルを以下 3 種類のバンドルに分類するだけ
     - `aggregator_bundles`: 同じ痛みを指す **3+ signals** のクラスタ（集約者に渡す）
     - `combinator_pairs`: 痛み × 技術/手法の組み合わせ候補で **2+ signals**（結合者に渡す）
     - `gap_candidates`: Launch/Show HN 告知や「隙間が見える」単発シグナル **1+ signals**（隙間発見者に渡す）
2. **Sonnet × 3 役割を並列実行**（各役割が異なる視点でアイデア起草）
   - **集約者 (Aggregator)**: 3+ signals の同一痛みクラスタから、堅実に裏取れた痛みを解決するアイデア
   - **結合者 (Combinator)**: 痛み + 技術/情報 の掛け合わせで、新しい解決策を発想する（例: 新 API × 既存の面倒）
   - **隙間発見者 (Gap-finder)**: 既存プロダクト告知や既存サービス言及から、まだ誰も埋めていない隙間・隣接ドメイン移植・非エンジニア向け化・有料の隙間を狙う
3. 3 役割の候補アイデアを合流 → `raw_score` DESC で Top 10 を選出
4. Top 10 を既存の Sonnet スコアリング（3 軸）に渡し、Tavily Search で類似サービス検索 → `competitors` に格納
5. `ideas` テーブルに Top 5 を格納（`role` を観測ログに出す）

**各役割の最低シグナル要件:**
| 役割 | 最低 signals | 理由 |
|------|-------------|------|
| 集約者 | **3+** 厳守 | 複数のシグナルで裏取れていない痛みは集約価値が薄い |
| 結合者 | **2+** | 痛み 1 本 + 技術/情報 1 本の最小ペア |
| 隙間発見者 | **1+** | 1 告知からでもドメイン移植・隙間発見は成立する |

### 配信層（S3 で実装）
- 直近 24 時間の未配信 `ideas` から `total_score DESC` で Top 3〜5 選出
- Markdown レポート生成（テンプレート下記）
- Resend で自分宛メール送信
- レポートを `reports/YYYY-MM-DD-{am|pm}.md` としてリポジトリに commit

### Markdown レポートテンプレート

```markdown
# IdeaRadar - {{date}} {{slot_label}}

直近 24 時間のトップアイデア 3〜5 件

---

## 1. {{title}}

**WHY (誰のどんな痛みか)**: {{why}}

**WHAT (何を作るか)**: {{what}}

**HOW (どう実現するか)**: {{how}}

**カテゴリ**: {{category}}

**スコア**: 市場性 {{market}}/5 · 技術 {{tech}}/5 · 競合少 {{competition}}/5 · 合計 {{total}}/15

**類似サービス**: {{competitors}}

**元情報**: {{source_links}}

---
（以下、2〜5 件同様）
```

## スプリント分割

### S1: データ収集基盤（20〜25h）

**完了基準**（外部から観察可能な振る舞い）:
- 3 ソース全てから 6 時間おきに新規データ取得が動作する
- `raw_signals` テーブルに重複なく蓄積される
- GitHub Actions `collect.yml` が 6 時間おきに自動実行される
- 実行失敗時に通知が届く（GitHub Actions の Email 通知 or Issue 自動作成）
- 最初の 24 時間で 3 ソースから最低合計 50 件以上のデータが入る

### S2: LLM クラスタリング + 3 役割アイデア創出 + スコアリング（20〜25h）

**完了基準**:
- 日次バッチで直近 24 時間の `raw_signals` を処理しアイデア生成
- Haiku によるクラスタリングが動作（`aggregator_bundles` / `combinator_pairs` / `gap_candidates` の 3 種類を出力）
- Sonnet × 3 役割（集約者 / 結合者 / 隙間発見者）が並列でアイデア起草
- Sonnet による 3 軸スコアリングが動作（Top 10 のみ）
- Tavily Search による競合検索が動作
- `ideas` テーブルに 1 回の実行あたり Top 3〜5 の完全なアイデアが格納される
- 自己評価: 3 日間運用で「作りたい」と思うアイデアが 1 件以上出る、かつ 3 役割からそれぞれ少なくとも 1 件は最終出力されている日がある

### S3: Markdown レポート + Resend 配信（10〜15h）

**完了基準**:
- JST 朝 8:30 の 1 日 1 回、Top 3〜5 件の Markdown レポートが自分宛メールで届く
- レポートが `reports/YYYY-MM-DD-am.md` としてリポジトリに commit される
- `reports` テーブルに配信ログが記録される（UNIQUE(date, slot) で 1 日 1 行）
- 2 週間連続で安定稼働する

### Sprint A: 分析精度の底上げ（12〜18h / 完了）

S1〜S3 で「毎朝アイデアが届く」基盤は完成した。Sprint A は **analyze パイプラインの出力品質** を、ユーザーゴール (月 5 万円 = growth-channel 帯) に整合させる改修。3 つの改善を同一スプリントで実施する。

#### A-1: 需要シグナル定量化を drafter に渡す

- `raw_signals.metadata` に蓄積されているはてブ bookmark 数 / Zenn いいね・bookmarked 数 / HN score・descendants / Reddit score・comments を、**バンドル単位で集計して Sonnet drafter (3 役割) の user prompt に差し込む**
- ソース横断で合算しない（意味が違うため個別に集計）
- 実装: `src/analyzers/demand-summary.ts` (`buildDemandSummary` / `formatDemandSummaryForPrompt` / `logLineDemandSummary`)
- drafter 3 役割 (`sonnet-aggregator.ts` / `sonnet-combinator.ts` / `sonnet-gap-finder.ts`) の system prompt 末尾に「需要シグナルサマリが提示されたら WHY に定量引用を含め raw_score に反映する」指示を追記
- combinator は pain / info 側のサマリを別々に渡す (意味が違うため)

**完了基準**:
- analyze ログに各バンドルの `demand_summary` が 1 行で出る (`signals=5 bkm_total=482 hn_avg=62` 等)
- WHY 本文に「累計 240 bkm」「HN 平均 87pt」等の定量引用を含む idea が週 5 日以上観測できる

#### A-2: Tavily saturation バグ修正

- Tavily 検索が失敗 or 空レスポンスのとき、Sonnet スコアラーが「競合なし」と誤読して `competition_score` を過大評価する問題
- `TavilyStatus = 'ok' | 'empty' | 'failed'` を `sonnet.ts` で export し、`scoreIdea(candidate, hits, status, options)` シグネチャに追加
- system rubric に「status が empty または failed の場合、競合状況を網羅的に検証できていないため competition_score は最大 3 に制限」を明記
- user prompt に `# 検索状態` セクションを追加して状態を Sonnet に明示

**完了基準**:
- `analyze` ログで `[tavily] q="..." hits=N status=ok/empty/failed` が観測できる
- Tavily 失敗日も `competition_score <= 3` に抑制される

#### A-3: ゴール帯別スコアリング + 重み付き weighted_score + tech_score 足切り

- 月収ゴール `TARGET_MRR` (定数、`src/lib/goal-band.ts` にハードコード、初期値 50000 円) に基づいて Sonnet rubric と `weighted_score` の重みを 3 帯で切り替える
- 帯の境界値と重み (market / tech / competition):

  | 帯 | 境界 | 重点 | 重み |
  |---|---|---|---|
  | niche-deep | ≤ 20,000 円 | コアユーザー深掘り、競合回避 > 市場サイズ | 1.0 / 1.0 / 1.5 |
  | growth-channel | 20,001〜200,000 円 | 持続性・流通設計・支払文化 | 1.5 / 1.0 / 1.0 |
  | moat | > 200,000 円 | 参入障壁 (データ / 規制) | 1.5 / 0.8 / 1.2 |

- `tech_score < 3` の idea は **ideas への insert 対象から除外** (足切り)。足切り後 5 件を切る日は実件数で deliver する
- `ideas.weighted_score numeric(4,2) NOT NULL` を新 migration で追加 (既存 `total_score` 列は互換維持)。重みは TypeScript 側で計算して insert する設計 (`TARGET_MRR` 定数を書き換えるだけで migration 不要)
- deliver 側 (`select-ideas.ts`) は `order by weighted_score DESC` に切り替え、`render-markdown.ts` のスコア表示は「合計 X.X（重み付き）」形式に変更
- 帯切り替え時は `src/lib/goal-band.ts` の `TARGET_MRR` 定数を書き換える (環境変数化しない)

**完了基準**:
- `analyze` ログに `target_mrr=50000 band=growth-channel weights=m1.5/t1.0/c1.0` が 1 回出る
- `ideas.tech_score < 3` の新規 insert が発生しない
- `ideas.weighted_score` が全新規行で NOT NULL、deliver 側が weighted_score 順で Top 5 を選ぶ
- 新 migration (`20260506000000_ideas_weighted_score.sql`) が単独で apply 可能、既存 migration は無変更

#### Sprint A 全体の完了判定 (Evaluator で PASS)

- [x] A-1 / A-2 / A-3 の受け入れ基準を満たす
- [x] `npm run typecheck` PASS
- [x] 冪等性 3 層 (`reports` UNIQUE / `ideas.delivered_at` / reports ガード) への影響なし
- [x] 既存 smoke コマンド (`--analyze` / `--deliver-dry`) は従来の引数で動作

本番反映手順:
1. Supabase 本番で `supabase/migrations/20260506000000_ideas_weighted_score.sql` を apply (`weighted_score` が NOT NULL のため deliver が走る前に必須)
2. 通常どおり collect → analyze → deliver が動けば Sprint A 完了

### Sprint B: 起草/スコアリングの構造追加（未着手 / 12〜18h 見込み）

Sprint A の定量化 + 帯別重み付けで「精度の底」は上がった。Sprint B はその上で **「起草と採点に構造的な反証と追加観点を入れる」** フェーズ。LLM コストがやや増える (Top 10 への追加呼び出し) ため、効果を見ながら段階的に入れる。

#### B-1: Devil's advocate 2-pass スコアリング

- Sonnet 初回スコア後、別呼び出しで「このアイデアを却下すべき 3 つの理由」を生成し、それを踏まえて再スコアする 2-pass 構成
- 甘めに振れる採点を締める定番手法。Top 10 のみ適用すればコスト増は限定的
- 実装: `src/analyzers/sonnet-devils-advocate.ts` を追加し、`scoreIdea` 後に `critiqueAndRescore(scored)` を通す。reasoning を `ideas.devils_advocate` jsonb に保持して後続検証に使えるようにする

#### B-2: 赤旗スキャン役割

- 既存 3 役割はポジティブ発想。法規制・API 利用規約・データ取得正当性の「地雷」を拾う役割が無い
- 追加する観点:
  - 薬機法 (SaMD 該当性)、金商法、資金決済法、景表法
  - スクレイピング禁止 API / 二要素認証越え
  - 医療・金融の誤った安心感 (倫理リスク)
- 実装: `src/analyzers/sonnet-risk-auditor.ts` を 4 番目の役割として追加。起草直後 (スコアリング前) に通して `ideas.risk_flags` に構造化して保持。赤旗ありでも除外はせず、deliver 側で「⚠️ 薬機法リスク: SaMD 該当性」等として Markdown に警告表示する
- Tavily で「薬機法 ガイドライン 2024」等を裏取りする経路を持たせるかは B-4 のクエリ多角化と合わせて判断

#### B-3: フェルミ推定の必須化

- 現状のアイデアには「どれくらい売れるか」の定量見積もりがなく、reality check が効いていない
- 各アイデアに「TARGET_MRR 到達に必要な顧客数 × 想定 ARPU × 継続月数」のフェルミ推定を必須化 (例: 買い切り 3,000 円 × 月 17 本で月 5 万円)
- 実装: drafter 3 役割の出力スキーマ (`HaikuIdeaCandidateSchema`) に `fermi_estimate: { unit_price, unit_type, mrr_formula }` を追加。推定不可能なアイデアは drafter が自主的に除外 (raw_score を下げる) する運用
- Markdown 表記に「月 5 万円到達: 買い切り 3,000 円 × 月 17 本」等の 1 行を追加

#### B-4: 検索クエリの多角化

- 現状 Tavily は `title + category_en` の英語 1 クエリのみ。日本市場の競合検出精度が弱い
- 改善: 以下 2-3 本を並列で投げて結果を union
  - 英語: `title + category_en` (現行)
  - 日本語: `title`（日本語）+ 「競合」「類似サービス」
  - 機能ワード: `what` から主要機能を 1-2 語抽出 + 英語
- Tavily 無料枠 1,000 req/月の範囲内に収まるよう、Top 10 × 2-3 クエリ = 月 600-900 req で試算
- 実装: `src/lib/tavily.ts` に `searchParallel(queries)` を追加、`analyze.ts` の `scoreTopCandidates` から呼ぶ

**Sprint B 完了基準（外部観察可能）:**
- [ ] Top 10 のアイデアに Devil's advocate 2-pass が適用され、ideas テーブルに却下理由が保持される
- [ ] 薬機法 / API 利用規約等のリスクがあるアイデアに `risk_flags` が付き、Markdown に警告表示される
- [ ] 全アイデアがフェルミ推定を含み、Markdown に「月 5 万円到達: ...」行が出る
- [ ] Tavily クエリが 2-3 本並列で投げられ、日本語競合が拾えるようになる
- [ ] LLM + Tavily 月コスト増が $10 以下に収まる

### Sprint C: スキーマ拡張と semantic 類似判定（未着手 / 10〜15h 見込み）

Sprint A/B が運用で効いているのを確認してから入れる。migration を伴うので Sprint B との同時着手は避ける。

#### C-1: 流通仮説フィールド（distribution_hypothesis）

- 「月 5 万円到達は作れば来るのではなく届け方次第」というゴール帯の認識をスキーマに刻む
- `ideas.distribution_hypothesis` を jsonb で追加。中身:
  - `channels`: 接触候補（コミュニティ / B2B 直営業 / 既存ツール連携）
  - `first_10_users`: 最初の 10 人をどう獲得するか
  - `sns_dependency`: SNS 依存度 (high/mid/low)。high は weighted_score 減点
- drafter 3 役割のスキーマと system prompt に反映
- Markdown に「**流通仮説**: ...」セクションを追加

#### C-2: Semantic dedup（embedding による近似重複除外）

- Sprint A で削除した「過去 N 日重複除外」が、運用が長くなって必要になった場合に備える (現時点では月 5 件 × 多様な 3-5 ソースで被りは少ない想定)
- `ideas.embedding vector(1024)` 列を Supabase pgvector で追加
- Anthropic / Voyage / OpenAI small のどれかで `title + what` を embedding
- analyze 内で直近 14〜30 日の既存 idea とコサイン類似度 > 0.85 のアイデアを除外
- 既存の軽量 dedup (title+category 完全一致) は残す (同一バッチ内の drafter 重複吸収用)

**Sprint C 完了基準:**
- [ ] `ideas.distribution_hypothesis` が新規 insert で必ず埋まる
- [ ] Markdown に流通仮説セクションが出る
- [ ] pgvector + embedding が稼働し、14 日以内の類似アイデアが除外される
- [ ] embedding コストが月 $3 以下

### 保留（当面は入れない）

- **3 役割間の cross-pollination**（combinator が aggregator の出力を参照する等）: 並列 → 直列化で analyze 時間が伸び、効果が不確実。B-1 の Devil's advocate で「別視点の反証」は代替される
- **ピボット候補の自動生成**（A/B/C 案併記）: Devil's advocate で「却下理由」が出れば人間側でピボット判断できる。月 5 件しか配信しない規模で AI が自動ピボットまでやる必要性は薄い

## コスト試算（月額）

| 項目 | コスト |
|-----|-------|
| Claude Haiku（クラスタリング、日次） | $1〜3 |
| Claude Sonnet × 3 役割（アイデア起草、日次） | $12〜18 |
| Claude Sonnet（スコア精査、日次 Top 10） | $6〜10 |
| GitHub Actions（~1,200 分/月） | $0（無料枠 2,000 分内） |
| Supabase Postgres | $0（500MB 以内） |
| Resend | $0（月 60 通以内） |
| Tavily Search API | $0（月 600 リクエスト想定、無料枠 1,000 req 内） |
| **合計** | **$20〜30** |

## 必要な外部アカウント・シークレット

GitHub Actions の Secrets に登録する環境変数:

| 変数名 | 用途 |
|-------|------|
| `SUPABASE_URL` | Supabase プロジェクト URL |
| `SUPABASE_SERVICE_ROLE_KEY` | DB 書き込み用 |
| `ANTHROPIC_API_KEY` | Claude API |
| `RESEND_API_KEY` | メール配信 |
| `RESEND_FROM_EMAIL` | 送信元アドレス |
| `RECIPIENT_EMAIL` | 自分のメールアドレス |
| `TAVILY_API_KEY` | 競合検索 |

## 将来の拡張（今回スコープ外）

- パーソナライズ（自分の技術スタック・過去の「作りたい」履歴でフィルタ）
- Web ダッシュボード（閲覧用、実装はローカルで十分）
- X 連携（有料 API 予算が出たとき）
- 過去アイデアの検索・お気に入り機能
- 「このアイデアで作った成果」のトラッキング

## ハーネス運用方針

- 各スプリント完了時に `evaluator` エージェントで完了基準の充足を検証する
- FAIL の場合、指摘事項を修正して再評価。PASS で次スプリントへ
- 同一スプリントで 3 回連続 FAIL ならユーザーに判断を仰ぐ
