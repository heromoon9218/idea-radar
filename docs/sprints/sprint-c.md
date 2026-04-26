# Sprint C: 流通仮説フィールドの追加（完了）

> 実装済み。本番 Supabase に migration 適用が手動オペで必要。
> evergreen な仕様は [`../../SPEC.md`](../../SPEC.md) を参照。

「月 5 万円到達は『作れば来る』ではなく『届け方を最初から設計する』」というゴール帯認識をスキーマに刻む狙い。Sprint C 当初は semantic dedup (C-2) も予定していたが、Anthropic に embedding API がなく Voyage / OpenAI 等の追加プロバイダ契約が必要になる割に、月 5 件 × 多様な 4 ソースで被りが少ない現状で運用コストに見合わないと判断し、SPEC.md の「保留」セクションに移した。

---

## distribution_hypothesis (流通仮説)

### 構造

`ideas.distribution_hypothesis jsonb`:
- `channels: string[]` (1-5 個) — 接触候補。抽象語 ("SNS" / "ブログ") ではなく具体名 ("業界 Discord" / "Notion Marketplace" / "Etsy フォーラム") を要求
- `first_10_users: string` — 最初の 10 人を誰にどこでどう獲得するかの 1-3 文シナリオ
- `sns_dependency: 'high' | 'mid' | 'low'` — SNS バイラル依存度

### 実装ポイント

- `HaikuIdeaCandidateSchema` で必須化、`DraftCandidateSchema` (drafter LLM 出力受け) は optional 受けにして欠落候補を `finalizeDraftCandidates` で warn + drop する 2 段防御
- drafter 3 役割 (aggregator / combinator / gap_finder) の system prompt 全てに「# 流通仮説 (distribution_hypothesis) の必須化」セクション追加
- `computeWeightedScore` (`src/lib/goal-band.ts`) に `sns_dependency` 補正を追加: `high=-1.0 / mid=0 / low=+0.5`、加減算後 `[0, 17.5]` でクランプ (numeric(4,2) と整合)
- `render-markdown.ts` で「**流通仮説**: チャネル: ... ｜ 初期 10 ユーザー: ... ｜ SNS 依存度: ...」の 1 行を出力。旧行 (NULL) はセクション省略

### マイグレーション

`supabase/migrations/20260520000000_ideas_distribution_hypothesis.sql`:
- `alter table ideas add column if not exists distribution_hypothesis jsonb` (NOT NULL なし)
- 旧行は NULL のまま残し、deliver 側でセクション省略フォールバック

---

## Sprint C 完了基準

- [x] `ideas.distribution_hypothesis` が新規 insert で必ず埋まる (drafter スキーマ + draft-filter で 2 段防御)
- [x] Markdown に「**流通仮説**: ...」セクションが出る
- [x] sns_dependency=high が weighted_score を減点する

---

## 引き継ぎ事項

- **本番 Supabase migration 適用** (手動): `20260520000000_ideas_distribution_hypothesis.sql` を本番に適用
- 新規 idea 5 件 × 数日経過後、`select count(*) from ideas where distribution_hypothesis is null and created_at > now() - interval '3 days'` で必須化が効いているか抜き取り確認

## 当初予定から外したもの

- **Semantic dedup (C-2)**: SPEC.md「保留」セクションに移送。Anthropic 公式の embedding API がない (Voyage AI / OpenAI 等の追加プロバイダ契約が必要) ことと、月 5 件 × 4 ソースで被りが少ない現状を勘案して見送り。重複が実害として観察された時点で再検討
