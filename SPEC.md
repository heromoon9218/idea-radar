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

- **Show / Ask / Launch HN の分類タグ** (実装済み): 「自作プロダクト告知・具体的課題質問・YC ローンチ」を優先シグナルとして識別し、Haiku プロンプトで raw_score に反映
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
  - Claude Haiku: 構造化（12h おき、大量処理）
  - Claude Sonnet: スコア精査（12h おき、少量のみ）
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
- `pain_summary` (text, 痛みの要約)
- `idea_description` (text, アイデア詳細)
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
- 直近 12 時間の `raw_signals` から未処理分を Haiku に投げる
- Haiku で: 痛み抽出 → アイデア化 → カテゴリ分類 → 類似マージ
- 候補アイデア Top 10 を Sonnet に渡して 3 軸スコア精査
- Tavily Search で類似サービス検索 → `competitors` に格納
- `ideas` テーブルに格納

### 配信層（S3 で実装）
- 直近 12 時間の未配信 `ideas` から `total_score DESC` で Top 3〜5 選出
- Markdown レポート生成（テンプレート下記）
- Resend で自分宛メール送信
- レポートを `reports/YYYY-MM-DD-{am|pm}.md` としてリポジトリに commit

### Markdown レポートテンプレート

```markdown
# IdeaRadar - {{date}} {{slot_label}}

直近 12 時間のトップアイデア 3〜5 件

---

## 1. {{title}}

**痛み**: {{pain_summary}}

**アイデア**: {{idea_description}}

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

### S2: LLM 構造化 + スコアリング（20〜25h）

**完了基準**:
- 12 時間おきバッチで直近 12 時間の `raw_signals` を処理しアイデア生成
- Haiku による構造化・カテゴリ分類・類似マージが動作
- Sonnet による 3 軸スコアリングが動作（Top 10 のみ）
- Tavily Search による競合検索が動作
- `ideas` テーブルに 1 回の実行あたり Top 3〜5 の完全なアイデアが格納される
- 自己評価: 3 日間運用で「作りたい」と思うアイデアが 1 件以上出る

### S3: Markdown レポート + Resend 配信（10〜15h）

**完了基準**:
- JST 朝 8:30 の 1 日 1 回、Top 3〜5 件の Markdown レポートが自分宛メールで届く
- レポートが `reports/YYYY-MM-DD-am.md` としてリポジトリに commit される
- `reports` テーブルに配信ログが記録される（UNIQUE(date, slot) で 1 日 1 行）
- 2 週間連続で安定稼働する

## コスト試算（月額）

| 項目 | コスト |
|-----|-------|
| Claude Haiku（構造化、12h おき） | $2〜6 |
| Claude Sonnet（スコア精査、12h おき Top 10 のみ） | $6〜16 |
| GitHub Actions（~1,200 分/月） | $0（無料枠 2,000 分内） |
| Supabase Postgres | $0（500MB 以内） |
| Resend | $0（月 60 通以内） |
| Tavily Search API | $0（月 600 リクエスト想定、無料枠 1,000 req 内） |
| **合計** | **$10〜24** |

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
