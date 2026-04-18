# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

IdeaRadar Personal — 個人用途のアイデア発掘ツール。詳細な製品仕様・スプリント定義・完了基準は `SPEC.md` が source of truth。機能追加や仕様変更を行う際は必ず先に `SPEC.md` を読むこと。

## 常用コマンド

```bash
npm run typecheck          # tsc --noEmit。CI でも毎ワークフローで実行される
npm run collect            # S1: 3 ソースから raw_signals を upsert
npm run analyze            # S2: Haiku → Tavily → Sonnet → ideas insert
npm run deliver            # S3: 未配信 ideas を Markdown 化して Resend 送信 + reports 記録

npm run smoke              # コレクタ 3 種を dry-run (認証不要)
npm run smoke -- --analyze       # Haiku + Tavily + Sonnet を 1 件だけ通電確認
npm run smoke -- --deliver-dry   # 未配信 ideas を Markdown レンダまで実行 (送信・DB書込なし)
```

テスト単体実行コマンドは存在しない。動作検証は `smoke.ts` のサブコマンドで行う。

## アーキテクチャ概要

### 3 段パイプライン（GitHub Actions cron、JST 朝に 1 日 1 回）

```
collect.yml (UTC 22:00 = JST 07:00)
  → src/collect.ts
  → 3 ソース (hatena / zenn / hackernews) 並列取得
  → raw_signals に UNIQUE(source, external_id) で重複除外 upsert

analyze.yml (UTC 23:00 = JST 08:00、timeout 15min)
  → src/analyze.ts
  → raw_signals (processed=false, 直近 12h) を Haiku チャンク (40件) で構造化
  → 上位 10 件を Tavily 競合検索 + Sonnet 3 軸スコア
  → ideas テーブルに最大 5 件 insert、signals を processed=true 更新

deliver.yml (UTC 23:30 = JST 08:30、analyze から 15min マージン)
  → src/deliver.ts
  → ideas (delivered_at IS NULL, 直近 12h, total_score DESC) Top 5 を選択
  → Markdown + HTML 生成 → Resend 送信
  → reports insert / ideas.delivered_at 更新 / reports/YYYY-MM-DD-am.md を git push
```

各ワークフロー失敗時は `failure()` 条件で Issue を起票する（直近 24h の同ラベル Issue があればコメント追加のみ、Issue 乱立防止）。

### `reports/` ディレクトリの扱い

- **gitignore されていない出力ディレクトリ**。deliver 成功時に `reports/YYYY-MM-DD-am.md` がワークフローから自動 commit & push される
- **`workflow_dispatch` を main 以外から起動しても commit されない**（`deliver.yml` が `GITHUB_REF != refs/heads/main` を検出して skip）。feature ブランチで配信テストしたい場合はメール送信のみ動き、レポートファイルは push されない
- push 競合時は rebase retry が 3 回走る（`deliver.yml` 末尾）

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

### HN `story_type` の伝播

Hacker News のタイトル先頭 `Show/Ask/Launch/Tell HN:` は個人開発ネタの金鉱として Haiku プロンプトで優先度を上げる設計。`hackernews.ts:classifyHnTitle` で分類 → `raw_signals.metadata.story_type` に格納 → `analyze.ts:toHaikuInputs` で `hn_story_type` にリフト → `HAIKU_SYSTEM` プロンプトに判定指針として渡る。新ソース追加時に類似のメタデータを通す必要がある場合、この 3 点を揃えること。

## データベース（Supabase Postgres）

- マイグレーションは `supabase/migrations/` に timestamp プレフィックス付き SQL で追加
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

## ハーネス運用方針（本プロジェクト特有）

SPEC.md 末尾および `~/.claude/rules/harness-engineering.md` に基づく：

- 各スプリント（S1/S2/S3）の完了時は `evaluator` エージェントで完了基準の充足を検証する
- FAIL の指摘は「厳しすぎる」と解釈せず必ず修正 → 再評価
- 同一スプリントで 3 回連続 FAIL ならユーザーに判断を仰ぐ
- コミットメッセージ・PR 本文・Issue は日本語

## 環境変数（.env もしくは GitHub Actions Secrets）

`SPEC.md` の「必要な外部アカウント・シークレット」表を参照。`ANTHROPIC_API_KEY` / `RESEND_API_KEY` は遅延初期化されるため、該当機能を使わない経路では未設定でも起動する。
