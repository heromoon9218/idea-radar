import 'dotenv/config';
import { supabase } from './db/supabase.js';
import { collectHatena } from './collectors/hatena.js';
import { collectZenn } from './collectors/zenn.js';
import { collectHackerNews } from './collectors/hackernews.js';
import { collectNote } from './collectors/note.js';
import { collectReddit } from './collectors/reddit.js';
import { RawSignalInputSchema } from './types.js';
import type { RawSignalInput, SourceType } from './types.js';

// cron は 1 日 1 回 (JST 7 時)。取りこぼし防止のため 10 分バッファを入れて 1450 分ウィンドウで取得。
const WINDOW_MINUTES = 1450;
// HN normal (Show/Ask/Launch/Tell プリフィックスなしの通常投稿) は 24h で 400+ 件発生し
// score 1-2 で埋もれる記事が大半。score 上位 N 件のみ採用してノイズを削る。
// hatena (~38) + zenn (~100) + HN 非 normal (~75) + HN normal top 100 = 約 313 件で、
// analyze 側の MAX_SIGNALS_PER_BATCH=500 に収まり取りこぼしが無くなる。
const HN_NORMAL_TOP_BY_SCORE = 100;

type CollectorFn = () => Promise<RawSignalInput[]>;

interface CollectorResult {
  source: SourceType;
  count: number;
  ms: number;
  error: string | null;
}

async function runCollector(
  source: SourceType,
  fn: CollectorFn,
): Promise<{ result: CollectorResult; items: RawSignalInput[] }> {
  const started = Date.now();
  try {
    const items = await fn();
    return {
      result: { source, count: items.length, ms: Date.now() - started, error: null },
      items,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      result: { source, count: 0, ms: Date.now() - started, error: message },
      items: [],
    };
  }
}

async function main(): Promise<void> {
  console.log(`[collect] window=${WINDOW_MINUTES}min, started=${new Date().toISOString()}`);

  const collectors: Array<[SourceType, CollectorFn]> = [
    ['hatena', () => collectHatena(WINDOW_MINUTES)],
    ['zenn', () => collectZenn(WINDOW_MINUTES)],
    [
      'hackernews',
      () =>
        collectHackerNews(WINDOW_MINUTES, { normalTopByScore: HN_NORMAL_TOP_BY_SCORE }),
    ],
    // 軽量ドメイン (クリエイター / 副業 / 個人 EC / 個人投資家 / 自己管理) の痛みを拾うソース。
    //   note:   複数ハッシュタグ RSS 束ね (~50-150 件)
    //   reddit: 5 subreddit × 25 件 = 最大 125 件 (stickied / NSFW 除外後やや減る)
    // 既存 313 件 + note ~100 + reddit ~100 = 約 510 件 になる見込みのため、
    // analyze 側の MAX_SIGNALS_PER_BATCH は 500 → 700 に引き上げ済み (src/analyze.ts)。
    ['note', () => collectNote(WINDOW_MINUTES)],
    ['reddit', () => collectReddit(WINDOW_MINUTES)],
  ];

  const outcomes = await Promise.all(
    collectors.map(([source, fn]) => runCollector(source, fn)),
  );

  const allItems = outcomes.flatMap((o) => o.items);

  // バリデーション（不正データはスキップしてログ出力）
  const validated: RawSignalInput[] = [];
  for (const item of allItems) {
    const parsed = RawSignalInputSchema.safeParse(item);
    if (!parsed.success) {
      console.warn(
        `[collect] invalid signal from ${item.source} (${item.external_id}): ${parsed.error.message}`,
      );
      continue;
    }
    validated.push(parsed.data);
  }

  // サマリ
  for (const { result } of outcomes) {
    const status = result.error ? `FAIL (${result.error})` : `ok`;
    console.log(
      `[collect] ${result.source.padEnd(12)} count=${String(result.count).padStart(3)} ${result.ms}ms ${status}`,
    );
  }
  console.log(`[collect] total_valid=${validated.length}`);

  const errorCount = outcomes.filter((o) => o.result.error).length;
  const failThreshold = Math.ceil(outcomes.length / 2);

  if (validated.length === 0) {
    console.log('[collect] nothing to upsert');
    // ソースの過半数が失敗していれば workflow を FAIL 扱いにして通知を発火させる
    process.exit(errorCount >= failThreshold ? 1 : 0);
  }

  const { error } = await supabase
    .from('raw_signals')
    .upsert(validated, { onConflict: 'source,external_id', ignoreDuplicates: true });

  if (error) {
    console.error('[collect] upsert failed:', error);
    process.exit(1);
  }

  console.log(`[collect] upsert ok, done=${new Date().toISOString()}`);

  // ソースの過半数が失敗していれば workflow を FAIL 扱いにして通知を発火させる
  if (errorCount >= failThreshold) {
    console.error(
      `[collect] ${errorCount}/${outcomes.length} collectors failed (threshold=${failThreshold})`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[collect] unhandled:', err);
  process.exit(1);
});
