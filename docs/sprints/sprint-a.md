# Sprint A: 分析精度の底上げ（完了）

> 実装済み。2026-04-21 に PR #29 (932c803) でマージ、本番 Supabase に migration 適用済み。  
> evergreen な仕様は [`../../SPEC.md`](../../SPEC.md) を参照。

S1〜S3 で「毎朝アイデアが届く」基盤は完成した。Sprint A は **analyze パイプラインの出力品質** を、ユーザーゴール (月 5 万円 = growth-channel 帯) に整合させる改修。3 つの改善を同一スプリントで実施した。

---

## A-1: 需要シグナル定量化を drafter に渡す

- `raw_signals.metadata` に蓄積されているはてブ bookmark 数 / Zenn いいね・bookmarked 数 / HN score・descendants / Reddit score・comments を、**バンドル単位で集計して Sonnet drafter (3 役割) の user prompt に差し込む**
- ソース横断で合算しない（意味が違うため個別に集計）
- 実装: `src/analyzers/demand-summary.ts` (`buildDemandSummary` / `formatDemandSummaryForPrompt` / `logLineDemandSummary`)
- drafter 3 役割 (`sonnet-aggregator.ts` / `sonnet-combinator.ts` / `sonnet-gap-finder.ts`) の system prompt 末尾に「需要シグナルサマリが提示されたら WHY に定量引用を含め raw_score に反映する」指示を追記
- combinator は pain / info 側のサマリを別々に渡す (意味が違うため)

**完了基準**:
- analyze ログに各バンドルの `demand_summary` が 1 行で出る (`signals=5 bkm_total=482 hn_avg=62` 等)
- WHY 本文に「累計 240 bkm」「HN 平均 87pt」等の定量引用を含む idea が週 5 日以上観測できる

---

## A-2: Tavily saturation バグ修正

- Tavily 検索が失敗 or 空レスポンスのとき、Sonnet スコアラーが「競合なし」と誤読して `competition_score` を過大評価する問題
- `TavilyStatus = 'ok' | 'empty' | 'failed'` を `sonnet.ts` で export し、`scoreIdea(candidate, hits, status, options)` シグネチャに追加
- system rubric に「status が empty または failed の場合、競合状況を網羅的に検証できていないため competition_score は最大 3 に制限」を明記
- user prompt に `# 検索状態` セクションを追加して状態を Sonnet に明示

**完了基準**:
- `analyze` ログで `[tavily] q="..." hits=N status=ok/empty/failed` が観測できる
- Tavily 失敗日も `competition_score <= 3` に抑制される

---

## A-3: ゴール帯別スコアリング + 重み付き weighted_score + tech_score 足切り

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

---

## Sprint A 全体の完了判定 (Evaluator で PASS)

- [x] A-1 / A-2 / A-3 の受け入れ基準を満たす
- [x] `npm run typecheck` PASS
- [x] 冪等性 3 層 (`reports` UNIQUE / `ideas.delivered_at` / reports ガード) への影響なし
- [x] 既存 smoke コマンド (`--analyze` / `--deliver-dry`) は従来の引数で動作

**本番反映手順** (実施済み):
1. Supabase 本番で `supabase/migrations/20260506000000_ideas_weighted_score.sql` を apply (`weighted_score` が NOT NULL のため deliver が走る前に必須)
2. 通常どおり collect → analyze → deliver
