# 2026-04-29 ソース品質向上 (ad-hoc)

> ad-hoc 対応 (Sprint ではない)。直近 3 日のスコア低迷・配信ゼロを受けた品質改善 7 項目の振り返り。
> evergreen な仕様は [`../../SPEC.md`](../../SPEC.md) を参照。
> 詳細実装は PR #51 / 各ファイルの「2026-04-29」コメント参照。

## 背景

直近 3 日連続で `ideas` の `weighted_score` 上位が足切り (`market_score >= 3 AND competition_score >= 3 AND distribution リスク high なし`) を抜けず、`reports` への idea insert が 0 件 → 配信ゼロが続いていた。

仮説:
1. SE 14 サイトのうち `lifehacks` / `interpersonal` / `academia` が雑談・大学経費依存で支払文化が弱く、痛みクラスタを形成しても収益化線まで届いていない
2. HN プリフィックス regex (`^\s*(show|ask|launch|tell)\s+hn\s*:`) が表記揺れに非寛容で、`Launch HN` が 3 日 0 件だった
3. HN normal の score 上位 30 圧縮が効きすぎて、score は伸びていないが「I'd pay $X for…」のような支払意欲シグナルを取りこぼしている
4. show/ask/launch HN の post 本文は外部 URL のみで空のことが多く、コメントスレッドにある隣接ペイン情報を Haiku が見られていない
5. 重いドメイン (士業 / 医療 / 介護 / 飲食店経営 / 中小製造 / エンプラ) の signal が drafter まで通って、起草はされるが distribution_hypothesis 評価で減点され配信に届かない
6. Haiku のバンドル閾値 (aggregator ≥3 / combinator pain+info ≥2 / gap secondary ≥1) が緩く、弱いクラスタを drafter に渡してしまい Sonnet コストの割に PASS 率が低い
7. Tavily の `searchParallel` が `status='empty'` (= 全クエリ成功 0 件) のとき、再検索せず競合不明のまま競合スコア最大値で抜けるケースがある

これら 7 項目を 1 PR で同時投入し、本番ログで効果観測することにした。

---

## 改善項目

### 1. SE サイト入替 (15 → 14 サイト)

`src/collectors/stackexchange.ts:SITES`:
- 削除: `lifehacks` (雑談) / `interpersonal` (個人感情) / `academia` (大学経費依存)
- 追加: `freelancing` (請求・契約・税務の実務痛み、個人事業主の支払文化) / `pm` (プロジェクト管理、PM はツール導入決裁権あり)

`productivity` SE は SE Network から廃止済みのため不採用 (smoke 実行時に `site=productivity` が HTTP 400 を返したことを 2026-04-29 確認)。差し引き 1 サイト減で 15 → 14。

`HAIKU_SYSTEM` プロンプトに「freelancing / pm の 2 サイトは支払文化が強いので、痛みが薄くてもバンドル化対象にしてよい」優遇指示を追加。

### 2. HN プリフィックス regex 寛容化

`src/collectors/hackernews.ts:HN_TITLE_PREFIX_RE`:
- 旧: `/^\s*(show|ask|launch|tell)\s+hn\s*:/i` (空白必須・コロン必須)
- 新: `/^\s*(show|ask|launch|tell)\s*hn\s*[:：—\-–]/i`

セパレータを 5 種 (半角コロン / 全角コロン / em dash / hyphen / en dash) 受容。`ShowHN:` / `Show HN — ` / `Show HN - ` / `Show HN：` も拾えるように。

### 3. HN normal の支払意欲救済

`HN_NORMAL_SALVAGE_BY_PAYMENT_INTENT = 20`。score 上位 30 から外れた normal でも、タイトル/本文に `PAYMENT_INTENT_RE` (`pay for` / `i'd pay` / `willing to pay` / `subscription` / `monthly fee` / `pricing tier` 等) がマッチすれば最大 20 件救済。救済された signal には `metadata.payment_intent: true` が付与され、Haiku 入力に lift される。

偽陽性 (`subscribe to RSS` 等) は許容 — Haiku 側でクラスタリング時に弾かれる前提。

### 4. HN コメント取得 (show/ask/launch のみ)

`HN_FETCH_TOP_COMMENTS_FOR = ['show', 'ask', 'launch']` / `HN_TOP_COMMENTS_LIMIT = 5`。HN API の `kids` を辿ってトップコメントを 5 件取得し `metadata.top_comments` に格納。`toHaikuInputs` で content に追記してから Haiku に渡す。

`kids` は **score 順ではなく投稿順 (古い順)** という制約あり (HN API の仕様)。完璧ではないが軽量取得でコスト/精度バランス重視。worst case 70 post × 5 comment = 350 req 追加。

show_hn の post 本文は外部 URL のみで空のことが多いが、コメントには「これも欲しい」「これじゃ足りない」「Y はどう?」といった隣接ペインが大量にあるので、Haiku のクラスタリング材料として有効と判断。

### 5. heavy_domain 早期タグ付け

新規 `src/lib/heavy-domain.ts`。日本語 substring マッチ (士業 / 医療 / 介護 / 飲食店経営 / 中小製造 / エンプラ等) + 英語 word boundary マッチで `metadata.heavy_domain: true` を `collect.ts` 時点で付与。

完全 skip ではなく **タグ付け方式** を採用した理由:
1. 誤検知 (例: freelancing で受けた医療系案件のような freelancing pain) を救済できる
2. raw_signals 自体は保持するので、後で集計したり方針転換したい時に遡れる
3. heavy_domain でも「個人で痛みを感じた経験談」(他 SE サイトに紛れた重いドメイン質問等) は gap_candidate other 経由で稀に拾われる余地を残せる

`HAIKU_SYSTEM` プロンプトに「heavy_domain=true は aggregator/combinator pain 側に入れない、gap_candidates の other に分類するか痛みが薄ければ捨てる」指示と例外節 (freelancing 文脈・個人体験談) を追加。

### 6. Haiku バンドル閾値引き上げ

`src/analyzers/haiku.ts`:
- `AGGREGATOR_MIN_SIGNALS`: 3 → **5**
- `COMBINATOR_MIN_TOTAL_SIGNALS`: pain+info 合計 2 → **3** (新規 check)
- `GAP_MIN_SIGNALS_PRIMARY` (launch_hn / show_hn): **1** (据え置き、HN 1 post 単独で需要検証済み事例として成立)
- `GAP_MIN_SIGNALS_SECONDARY` (paid_service_mention / niche_transfer / other): 1 → **2**

「弱いクラスタを drafter に渡さない」狙い。drafter は Sonnet × 3 役割なので 1 起草あたり ~$0.05 のコスト、PASS 率が低いと差し引きが赤字になる。

### 7. Tavily empty フォールバック

`src/analyze.ts:buildFallbackQuery` を新規追加。`searchParallel` が `status='empty'` を返したとき、`why` の先頭 80 文字 + `CATEGORY_EN[c.category]` + `"alternative tool"` で 1 本だけ追加発行。

`status='failed'` (= ネットワーク / 認証エラー) のときは呼ばない (原因が変わらず credit を浪費するため)。

「title が specific すぎて競合に当たらないが、別の用語で類似サービスがある」ケースを救う狙い。

---

## 観測すべきメトリクス

本番 analyze ログで以下を観測し、効果検証または巻き戻し判断する:

| ログプレフィックス | 観測する値 | 判断基準 |
|---|---|---|
| `[collect] heavy_domain tagged=N/M` | 比率 (N/M) | 5-15% 程度が想定。50% 超なら誤検知率を疑う |
| `[hn] top_comments fetched for X/Y posts` | Y 件数 | 50-70 件 / 日が想定 |
| `[haiku] drop aggregator_bundle (valid_ids<5)` | 頻度 | 全 drop の半数超なら閾値 4 にロールバック検討 |
| `[haiku] drop combinator_pair (pain+info<3)` | 頻度 | 同上 |
| `[tavily] fallback recovered N hits` | 発火率 | empty 時の復活率 30% 超なら有効 |
| 配信件数 (deliver step) | 1 日 0-5 件 | 3 日連続 0 件なら閾値巻き戻し |

---

## ロールバック判断基準

### 即時ロールバック (3 日連続配信 0)

最も影響が大きいのは閾値引き上げ (改善項目 6) と思われるため、優先順位:
1. `AGGREGATOR_MIN_SIGNALS`: 5 → 4 (3 まで戻す前にまず 1 段階)
2. `COMBINATOR_MIN_TOTAL_SIGNALS`: 3 → 2 (元に戻す)
3. `GAP_MIN_SIGNALS_SECONDARY`: 2 → 1 (元に戻す)

### 個別調整 (特定メトリクスが極端な場合)

- `heavy_domain tagged` が 50% 超 → `HEAVY_DOMAIN_KEYWORDS_JA` から偽陽性の多いキーワード (例: `医療現場` `医薬品`) を絞る
- `top_comments` が 30 件未満 → kids 取得対象を `[0..15]` に広げて score 降順 5 件に絞る (追加 10 req/post)
- Tavily `fallback recovered` が 10% 未満 → fallback クエリの組み立てを見直し (英語固定の `alternative tool` を `代替ツール` 等の日本語混在に変える等)

---

## 当初予定から外したもの

- **SE freelancing/pm signal の heavy_domain 判定スキップ**: heavy_domain と SE site の優先順位を構造的に保証する案 (例: SE site=freelancing/pm の signal は `detectHeavyDomain` を skip する)。Haiku プロンプトの例外節で代替できているが、プロンプト依存より構造的保証の方が望ましい。次回 PR で検討。
- **HN コメントの score 順ソート**: kids を `[0..15]` 広げてスコア降順で 5 件に絞る案。追加 req コストとのトレードオフで初版は見送り。`top_comments` の質感が低ければ後追い対応。

---

## 関連ファイル

- `src/collectors/stackexchange.ts` (SE 入替の経緯コメント)
- `src/collectors/hackernews.ts` (regex 寛容化 / 救済 / コメント取得)
- `src/lib/heavy-domain.ts` (新規、キーワード辞書)
- `src/analyzers/haiku.ts` (プロンプト改修 / 閾値引き上げ)
- `src/analyze.ts` (top_comments lift / Tavily fallback)
- `src/types.ts` (`heavy_domain` / `payment_intent` を `HaikuSignalInputSchema` に追加)
