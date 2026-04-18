// 認証不要なコレクタ / 認証必要な analyze パイプラインのスモークテスト。
// 使い方:
//   npx tsx src/scripts/smoke.ts            # コレクタ 3 種を dry-run (認証不要)
//   npx tsx src/scripts/smoke.ts --analyze  # Haiku / Tavily / Sonnet を 1 件だけ通電確認
//                                           (要 ANTHROPIC_API_KEY, TAVILY_API_KEY,
//                                            SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
// analyze モードは DB に書き込まず、LLM と Tavily の結果を stdout に出すだけ。

import 'dotenv/config';
import { collectHatena } from '../collectors/hatena.js';
import { collectZenn } from '../collectors/zenn.js';
import { collectHackerNews } from '../collectors/hackernews.js';
import { extractIdeas } from '../analyzers/haiku.js';
import { scoreIdea } from '../analyzers/sonnet.js';
import { tavilySearch } from '../lib/tavily.js';
import { supabase } from '../db/supabase.js';
import {
  HaikuSignalInputSchema,
  type HaikuSignalInput,
  type RawSignalInput,
} from '../types.js';

const WINDOW_MIN = 1440; // 過去24h
const ANALYZE_SAMPLE_SIZE = 5;

type SmokeCollector = readonly [string, () => Promise<RawSignalInput[]>];

async function smokeCollectors(): Promise<void> {
  const collectors: readonly SmokeCollector[] = [
    ['hatena', () => collectHatena(WINDOW_MIN)],
    ['zenn', () => collectZenn(WINDOW_MIN)],
    ['hackernews', () => collectHackerNews(WINDOW_MIN)],
  ];

  for (const [name, fn] of collectors) {
    const started = Date.now();
    try {
      const items = await fn();
      const ms = Date.now() - started;
      console.log(`[${name.padEnd(10)}] ok   count=${String(items.length).padStart(3)} ${ms}ms`);
      const sample = items[0];
      if (sample) {
        console.log(`  - title:     ${sample.title.slice(0, 80)}`);
        console.log(`  - posted_at: ${sample.posted_at}`);
        console.log(`  - url:       ${sample.url}`);
      }
    } catch (err) {
      const ms = Date.now() - started;
      console.error(`[${name.padEnd(10)}] FAIL ${ms}ms`, err);
    }
  }
}

async function smokeAnalyze(): Promise<void> {
  console.log(`[smoke-analyze] sample_size=${ANALYZE_SAMPLE_SIZE}`);

  // 1) DB からサンプル signals を取得 (processed 問わず最新を拾う)
  const { data, error } = await supabase
    .from('raw_signals')
    .select('id, source, title, content, url')
    .order('collected_at', { ascending: false })
    .limit(ANALYZE_SAMPLE_SIZE);
  if (error) throw error;
  const rows = data ?? [];
  console.log(`[smoke-analyze] fetched=${rows.length}`);
  if (rows.length === 0) {
    console.log('[smoke-analyze] no signals in DB, aborting');
    return;
  }

  const signals: HaikuSignalInput[] = [];
  for (const r of rows) {
    const parsed = HaikuSignalInputSchema.safeParse(r);
    if (!parsed.success) {
      console.warn(`[smoke-analyze] drop invalid signal ${r.id}: ${parsed.error.message}`);
      continue;
    }
    signals.push(parsed.data);
  }
  if (signals.length === 0) {
    console.log('[smoke-analyze] no valid signals, aborting');
    return;
  }

  // 2) Haiku 1 chunk
  const candidates = await extractIdeas(signals);
  console.log(`[smoke-analyze] haiku_candidates=${candidates.length}`);
  if (candidates.length === 0) {
    console.log('[smoke-analyze] no candidates from Haiku, stopping');
    return;
  }

  // 3) 最上位 1 件だけ Tavily + Sonnet を通電
  const top = [...candidates].sort((a, b) => b.raw_score - a.raw_score)[0]!;
  console.log('[smoke-analyze] top candidate:');
  console.log(JSON.stringify(top, null, 2));

  let hits: Awaited<ReturnType<typeof tavilySearch>> = [];
  try {
    hits = await tavilySearch(top.title, 5);
    console.log(`[smoke-analyze] tavily_hits=${hits.length}`);
  } catch (err) {
    console.warn('[smoke-analyze] tavily failed:', err instanceof Error ? err.message : err);
  }

  const scored = await scoreIdea(top, hits);
  console.log('[smoke-analyze] sonnet_output:');
  console.log(JSON.stringify(scored, null, 2));
  console.log(
    `[smoke-analyze] total_score=${
      scored.market_score + scored.tech_score + scored.competition_score
    }/15`,
  );
}

async function main(): Promise<void> {
  const mode = process.argv.includes('--analyze') ? 'analyze' : 'collectors';
  if (mode === 'analyze') {
    await smokeAnalyze();
  } else {
    await smokeCollectors();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
