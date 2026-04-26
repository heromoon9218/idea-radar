# IdeaRadar Personal — 仕様書

## 概要

個人開発で **月 ¥10k の収益** に到達するための「作るべきもの」を日次で発掘する自分用ツール。非技術の生活ペイン (Stack Exchange 15 サイト) を主要ソース、技術系情報 (Hacker News / Zenn / はてなブックマーク) を副次ソースとして「痛み」「愚痴」「ニーズ」を自動収集し、LLM で構造化・スコアリングした個人開発アイデア Top 3〜5 件を **JST 朝 7:30 の 1 日 1 回、自分宛メール** で配信する。

## 目的と評価軸

「作ってみたい度」ではなく、以下を主評価軸に置く：

- **非エンジニアまたは B2B 小口が金を払う可能性があるか** — 「開発者向け無料 DevTool」では ¥10k/月 に届きにくいため、需要検証済み・課金文化あり・競合ニッチ な領域を優先する
- **ソロ開発者が競合に埋もれずに入り込めるか** — 1〜3 ヶ月で MVP を出せる規模、かつ既存大手が手を出しにくい隙間であること
- **既に金が動いているドメインの「隙間」であるか** — 新規需要の創造より、既存需要の未充足ポイントを狙う

### 現在の情報源バイアスと緩和策

技術系 3 ソース (HN / Zenn / はてブ) だけでは読者層が開発者中心で、「自作できる・無料志向」の層に偏り DevTool / OSS 的アイデアに流されて目的から外れやすい。この偏りの緩和策：

- **Stack Exchange 15 サイトを主要ソースに据える**: 非技術 15 サイト (lifehacks / parenting / money / workplace / cooking / diy / interpersonal / travel / pets / gardening / fitness / law / outdoors / expatriates / academia) を **sort=month + sort=hot の 2 クエリ並走** で収集。classic pain と fresh pain の両面を網羅し、score / view_count / answer_count で demand-summary の裏取りも機能する
- **技術系ソースの圧縮**: Zenn count を 100 → 30、HN normal_top_by_score を 100 → 30 に圧縮。技術系バイアスを相対的に下げ、SE を主軸に据える
- **Show / Ask / Launch HN の分類タグ** (実装済み): 「自作プロダクト告知・具体的課題質問・YC ローンチ」を優先シグナルとして識別し、Haiku クラスタリング時に gap_candidates 側に流れやすくする
- **Sonnet × 3 役割のアイデア創出** (S2 実装): 集約者は「複数シグナルで裏取れた痛み」に集中し、結合者は「SE ペイン × 技術 info の掛け合わせ」を主軸に、隙間発見者は「既存プロダクト告知の穴・隣接ドメイン移植・非エンジニア向け化」を担う
- **将来の情報源拡張候補**: App Store 星 1-2 レビュー / Makuake 達成プロジェクト / クラウドワークス発注案件 / Indie Hackers milestones — 「既に金が動いている領域の隙間」が観察できるソース群
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
  - 収集ワークフロー: `cron: '0 21 * * *'`（UTC 21:00 = JST 翌朝 6:00、1 日 1 回）
  - 分析ワークフロー: `cron: '30 21 * * *'`（UTC 21:30 = JST 翌朝 6:30、1 日 1 回 / timeout 30min）
  - 配信ワークフロー: `cron: '30 22 * * *'`（UTC 22:30 = JST 翌朝 7:30、1 日 1 回 / 分析完了から 30min のマージン）

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
| **Stack Exchange (15 サイト)** | 公式 API v2.3 (sort=month + sort=hot 2 クエリ並走) | **主要ソース**。lifehacks / parenting / money / workplace / cooking / diy / interpersonal / travel / pets / gardening / fitness / law / outdoors / expatriates / academia |
| はてなブックマーク | Hotentry RSS / カテゴリ RSS | IT カテゴリ中心 (副次) |
| Zenn | 公式 API (count=30) | 記事・トレンド (副次) |
| Hacker News | Firebase API (normal は score 上位 30) | Top / Ask / Show / Launch HN (副次) |

**除外したソース**:
- **X（Twitter）**: 公式 API が月 $100 で無料化と両立不可
- **note / Reddit (過去に実装し 2026-04 に撤去)**: 両者とも RSS / Atom 経由では score / likes 等の定量メタが取得できず demand-summary に組み込めなかった。Stack Exchange に置き換え済み
- **Product Hunt**: 認証（OAuth / 開発者トークン）運用コストが高い割に日本語圏のシグナル密度が低いため保留
- いずれも将来必要になった時点で再検討

## データベーススキーマ（概要）

### `raw_signals`（生データ）
- `id` (uuid, pk)
- `source` (enum: hatena / zenn / hackernews / stackexchange)
- Stack Exchange は 15 サイト (lifehacks / parenting / money / workplace / cooking / diy / interpersonal / travel / pets / gardening / fitness / law / outdoors / expatriates / academia) を `metadata.se_site` で区別する
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
- 配信物はメール本文のみ（リポジトリへの commit はしない）

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

### 完了スプリント（履歴）

完了済みスプリントの完了基準・設計判断は `docs/sprints/` に切り出している。本 SPEC.md は evergreen な仕様に集中する。

- [基盤スプリント S1 / S2 / S3](docs/sprints/s1-s3-foundation.md) — 収集 / 分析 / 配信 の 3 段パイプライン基盤
- [Sprint A: 分析精度の底上げ](docs/sprints/sprint-a.md) — 需要シグナル定量化 / Tavily 状態ハンドリング / ゴール帯別 weighted_score
- [Sprint B: 起草・スコアリングの構造追加](docs/sprints/sprint-b.md) — Devil's advocate 2-pass / 赤旗スキャン / フェルミ推定必須化 / Tavily クエリ多角化
- [Sprint C: 流通仮説フィールドの追加](docs/sprints/sprint-c.md) — distribution_hypothesis (channels / first_10_users / sns_dependency) を drafter 必須化、Markdown と weighted_score に反映

### 保留（当面は入れない）

- **3 役割間の cross-pollination**（combinator が aggregator の出力を参照する等）: 並列 → 直列化で analyze 時間が伸び、効果が不確実。B-1 の Devil's advocate で「別視点の反証」は代替される
- **ピボット候補の自動生成**（A/B/C 案併記）: Devil's advocate で「却下理由」が出れば人間側でピボット判断できる。月 5 件しか配信しない規模で AI が自動ピボットまでやる必要性は薄い
- **Semantic dedup (embedding ベースの近似重複除外)**: 月 5 件 × 多様な 4 ソースで被りは少ない想定。Anthropic は embedding API を提供していないため Voyage AI / OpenAI 等の追加プロバイダ契約が必要になり、運用コスト > 効果と判断。重複が実害として観察されたら再検討

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
