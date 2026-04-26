# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

IdeaRadar Personal — 個人用途のアイデア発掘ツール。詳細な製品仕様・現行パイプライン・次スプリント定義は `SPEC.md` が source of truth。機能追加や仕様変更を行う際は必ず先に `SPEC.md` を読むこと。

完了済みスプリントの完了基準や設計判断は `docs/sprints/` に切り出している（SPEC.md から link されている）。過去の実装意図を追うときはそちらを参照する。未着手スプリントの詳細は SPEC.md 本体に残す運用。

## 常用コマンド

```bash
npm run typecheck          # tsc --noEmit。CI でも毎ワークフローで実行される
npm run collect            # S1: 3 ソースから raw_signals を upsert
npm run analyze            # S2: Haiku cluster → Sonnet × 3 役割 → Tavily → Sonnet score → ideas insert
npm run deliver            # S3: 未配信 ideas を Markdown 化して Resend 送信 + reports 記録

npm run smoke              # コレクタ 3 種を dry-run (認証不要)
npm run smoke -- --analyze       # Haiku + Tavily + Sonnet を 1 件だけ通電確認
npm run smoke -- --deliver-dry   # 未配信 ideas を Markdown レンダまで実行 (送信・DB書込なし)
```

テスト単体実行コマンドは存在しない。動作検証は `smoke.ts` のサブコマンドで行う。

**SQL 依存の差**: `npm run smoke` (flag なし) は HTTP → log のみで DB 書き込みしないので、新しい `source_type` enum 値を導入するマイグレが本番未適用でも安全に走る。一方 `npm run collect` と `npm run smoke -- --analyze` は `raw_signals` への insert があるため、新 enum 値を使うマイグレは事前に本番適用しておかないと `invalid input value for enum source_type` で落ちる。

CI（`.github/workflows/ci.yml`）は PR と push:main で `npm run typecheck` + `npm audit --audit-level=high` を実行する。新しい依存追加で high 以上の脆弱性が出ると CI が落ちる。

## アーキテクチャ概要

### ディレクトリ構成（`src/` 配下）

```
collectors/   hatena / zenn / hackernews / stackexchange の RSS・API 取得
analyzers/    haiku (クラスタリング) / sonnet-aggregator / sonnet-combinator / sonnet-gap-finder (3 役割) / sonnet (3 軸スコア)
lib/          anthropic / resend / tavily / fetch-retry — 外部 I/O 窓口
db/           supabase.ts — service role クライアント
report/       select-ideas / render-markdown / markdown-to-html / slot / persist
scripts/      smoke.ts — 手動通電確認
collect.ts, analyze.ts, deliver.ts — 各ワークフローのエントリポイント
types.ts      zod スキーマ + 型定義の集約
```

### 3 段パイプライン（GitHub Actions cron、JST 朝に 1 日 1 回）

```
collect.yml (UTC 21:00 = JST 06:00)
  → src/collect.ts
  → 4 ソース (hatena / zenn / hackernews / stackexchange) 並列取得
  → raw_signals に UNIQUE(source, external_id) で重複除外 upsert

analyze.yml (UTC 21:30 = JST 06:30、timeout 30min)
  → src/analyze.ts
  → raw_signals (processed=false, 直近 24h) を Haiku でクラスタリング
    (aggregator_bundles ≥3 / combinator_pairs ≥2 / gap_candidates ≥1 の 3 種類に分類)
  → Sonnet × 3 役割を並列実行してアイデア起草 (集約者 / 結合者 / 隙間発見者)
  → 合流して raw_score DESC で Top 10 を Tavily 競合検索 + Sonnet 3 軸スコア
  → 足切り (market_score >= 3 AND competition_score >= 3 AND distribution リスク high なし)
    → weighted_score DESC で Top 5 を ideas に insert、signals を processed=true 更新
    (技術難度の足切りは無し: 個人開発する意義があるアイデアは難度が高くても残す方針)

deliver.yml (UTC 22:30 = JST 07:30、analyze から 30min マージン)
  → src/deliver.ts
  → ideas (delivered_at IS NULL, 直近 24h, total_score DESC) Top 5 を選択
  → Markdown + HTML 生成 → Resend 送信
  → reports insert / ideas.delivered_at 更新（配信物はメールのみで、リポジトリへはコミットしない）
```

各ワークフロー失敗時は `failure()` 条件で Issue を起票する（直近 24h の同ラベル Issue があればコメント追加のみ、Issue 乱立防止）。

### 冪等性・二重配信ガード（`src/deliver.ts` 冒頭コメント参照）

重要な設計原則：**メール送信は 1 回、DB 書き込みは 2 段階、失敗しても二重配信しない**。

- **`reports` UNIQUE(date, slot)** → 同日再実行は `isAlreadyDelivered` で事前 skip
- **`ideas.delivered_at`** → 通常運用の配信済みマーカー
- **reports ガード**（`select-ideas.ts` の `fetchRecentlyReportedIdeaIds`）→ `markIdeasDelivered` が失敗して `delivered_at` が NULL のまま残ったケースでも、直近 2 日の `reports.idea_ids` に含まれる idea は除外する **二重防御**

冪等性を変更する場合、上記 3 層のどれか 1 つを壊すと二重配信が起こりうるため、必ず 3 層全体を見て整合を取ること。

### LLM 呼び出し規約

`src/lib/anthropic.ts` の `callParsed<Schema>` が Anthropic SDK v0.90 の `messages.parse + zodOutputFormat` を薄くラップした唯一の窓口。新しい LLM 呼び出しを追加する場合：

1. `src/types.ts` に zod スキーマを追加
2. `callParsed` 経由で呼び出し、戻り値を型安全に受け取る
3. API キーは**遅延初期化**（トップレベル throw 禁止）— smoke コレクタ単体実行時に `ANTHROPIC_API_KEY` なしでも動くこと

同じ規約が `src/lib/resend.ts` にも適用される。

**lenient schema の注意**: `callParsed` の schema は zod パースに加え `zodOutputFormat` 経由で JSON Schema として LLM 側にも送られる。strict → lenient に緩めると model 側 enum/min 制約も消えて出力ドリフトが増えるので、(1) prompt 側で semantic anchor + negative example で補強し、(2) それでも model が systematic に外すパターンは app 側で fuzzy matcher を用意する。`src/analyzers/haiku.ts` の `LenientHaikuClusterOutputSchema` + `fuzzyMatchGapAngle` が現行例 (Haiku が `show_hn` を `show_fn` / `show_hm` に頻繁に外すケース)。

### HN `story_type` の伝播

Hacker News のタイトル先頭 `Show/Ask/Launch/Tell HN:` は個人開発ネタの金鉱として Haiku クラスタリングで `gap_candidates` (show_hn / launch_hn) に強く振るための優先度シグナル。`hackernews.ts:classifyHnTitle` で分類 → `raw_signals.metadata.story_type` に格納 → `analyze.ts:toHaikuInputs` で `hn_story_type` にリフト → `HAIKU_SYSTEM` プロンプトに判定指針として渡る。新ソース追加時に類似のメタデータを通す必要がある場合、この 3 点を揃えること。

Stack Exchange も同じパターンを踏襲する: `stackexchange.ts` が `metadata.se_site` (15 サイト: lifehacks / parenting / money / workplace / cooking / diy / interpersonal / travel / pets / gardening / fitness / law / outdoors / expatriates / academia) を格納 → `analyze.ts:toHaikuInputs` が `se_site` にリフト → `HAIKU_SYSTEM` プロンプトが「生活ハック / 育児 / 家計 / 職場 / 料理」等の痛みとしてクラスタリングの判断材料にする。サイト一覧の単一の真実は `src/collectors/stackexchange.ts:SITES`。

### HN normal ノイズフィルタ

`collect.ts` は `collectHackerNews` に `normalTopByScore: 30` を渡す (SE 主要化に合わせて 100 → 30 に圧縮)。HN `normal` (Show/Ask/Launch/Tell プリフィックスなしの通常投稿) は 24h で 400+ 件発生し score 1-2 で埋もれる記事が大半なので、HN score 上位 30 件のみ採用してノイズを削る設計。`show` / `ask` / `launch` / `tell` は本数が少なく質も高いので常に全件保持する。
Stack Exchange を主要ソースに据えた (SE 15 サイト × sort=month/hot 2 クエリ) ため、技術系バイアス低減のため HN normal と zenn count を縮小した。これにより日次の収集件数は hatena (~38) + zenn (~30) + HN 非 normal (~75) + HN normal top 30 + stackexchange 15 site (~80-150) = **定常 250-350 件**、初回 ingest 時は SE の month/hot 2 クエリ合計で 700-800 件まで伸びる想定。analyze 側の `MAX_SIGNALS_PER_BATCH` は 1200、`HAIKU_MAX_SIGNALS` は 700。閾値を触る場合はこの収支を確認すること。

### Prompt caching

`callParsed` は `cacheSystem?: boolean` オプションを持つ。true のとき system プロンプトに `cache_control: ephemeral` を付け、5 分以内の再呼び出しで cached_input_tokens として 10% コストで扱われる。書き込みは 1.25× コストなので **2 回以上呼ぶ経路でのみ有効化**するのが原則。

現状の有効化箇所:
- `sonnet-aggregator.ts` / `sonnet-combinator.ts` / `sonnet-gap-finder.ts`: 各役割内で複数バンドルを順次処理する時にヒット
- `sonnet.ts` (3 軸スコアリング): Top 10 を連続呼び出しするので 2 回目以降ヒット

Haiku クラスタリングは 1 回/日のみなので cache は付けない (書き込みコストで損になる)。

## データベース（Supabase Postgres）

- マイグレーションは `supabase/migrations/` に timestamp プレフィックス付き SQL で追加
- **本番 Supabase への適用は手動**（CI は `typecheck` + `npm audit` のみで `supabase db push` を実行しない）。マイグレーション付き PR を出す前に、破壊的変更（DROP / enum 削除など）が含まれる場合は事前にユーザーに適用タイミングを確認する
- 主要テーブル：`raw_signals`（UNIQUE(source, external_id) + `processed` フラグ）、`ideas`（`total_score` は generated column）、`reports`（UNIQUE(date, slot)）
- DB クライアントは `src/db/supabase.ts`（`persistSession: false`、service role key 前提）
- **retention ポリシー**：`raw_signals` のみ pg_cron で日次クリーンアップ（`processed=true AND collected_at < now() - interval '30 days'`）。毎日 UTC 01:00 実行。`ideas` / `reports` は件数が少ないため保持。処理失敗で `processed=false` のまま残った行はクリーンアップ対象外（手動調査用）。ジョブ定義は `supabase/migrations/20260430000000_pg_cron_cleanup.sql`、稼働確認は `select * from cron.job_run_details` で可能

## コーディング規約

- **TypeScript ESM**：`type: module` + `moduleResolution: Bundler`。相対 import は `.js` 拡張子を付ける（`.ts` から `.js` を import するのが正解）
- **`noUncheckedIndexedAccess` 有効**：配列・レコード添字アクセスは常に `T | undefined`
- **zod でバリデーション**：外部データ（HTTP レスポンス・DB 行・LLM 出力）は全て zod スキーマで `safeParse`。失敗時は warn してスキップが基本方針（パイプライン全体を止めない）
- **`fetchWithRetry`** を HTTP 呼び出しで使用（5xx のみリトライ、4xx は即 return）

## コレクタ実装の注意点

- **`collectHatena` は `sinceMinutes` を無視する**：はてブ RSS の `dc:date` は「記事投稿時刻」で「hotentry 入り時刻」ではないため、時間窓フィルタをかけると恒常的に 0 件になる。全件を返し `UNIQUE(source, external_id) + ignoreDuplicates` に dedup を委ねる設計（`hatena.ts` のコメント参照）。Zenn/HN と挙動が非対称なので、共通インターフェースに寄せる修正を入れる際は要注意

### 新ソース追加時のチェックリスト

1. `src/types.ts` `SourceTypeSchema` enum に追加 + `supabase/migrations/` に `ALTER TYPE source_type ADD VALUE IF NOT EXISTS '{name}'` のマイグレーションを追加
2. `src/collectors/{name}.ts` を新規作成（既存コレクタと同じ `fetchWithRetry` パターン、識別可能な `User-Agent` 付与、`sinceMinutes` の解釈を他と揃える）
3. `src/collect.ts` の `collectors` / `src/scripts/smoke.ts` の `smokeCollectors` / `src/report/render-markdown.ts` の `SOURCE_JA` の 3 箇所に配線（`SOURCE_JA` は `Record` 網羅性チェックで typecheck が通らないので必ず追加）
4. 合計 signals 数が `src/analyze.ts` の `MAX_SIGNALS_PER_BATCH` を超える可能性を検算（現在 700）。超過時は上限引き上げか limit 削減で対応

## ハーネス運用方針（本プロジェクト特有）

SPEC.md 末尾および `~/.claude/rules/harness-engineering.md` に基づく：

- 各スプリントの完了時は `evaluator` エージェントで完了基準の充足を検証する
- FAIL の指摘は「厳しすぎる」と解釈せず必ず修正 → 再評価
- 同一スプリントで 3 回連続 FAIL ならユーザーに判断を仰ぐ
- コミットメッセージ・PR 本文・Issue は日本語
- **Sprint 名を勝手に命名しない**: SPEC.md には完了済み Sprint (S1-S3 / Sprint A / Sprint B / Sprint C) が `docs/sprints/` にリンクされている。現状 SPEC.md に未着手の Sprint 枠予約は無いので、"Sprint D" 以降を付けるときは SPEC.md / docs/sprints の最新状況を確認してから命名する。該当スコープでない ad-hoc 対応は Sprint 名を付けず、日付 / 機能名で書く（例: "SE 主要化", "2026-04 のソース入替"）

## 環境変数（.env もしくは GitHub Actions Secrets）

`SPEC.md` の「必要な外部アカウント・シークレット」表を参照。`ANTHROPIC_API_KEY` / `RESEND_API_KEY` は遅延初期化されるため、該当機能を使わない経路では未設定でも起動する。
