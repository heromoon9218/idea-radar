import 'dotenv/config';
import { supabase } from './db/supabase.js';
import { extractIdeas } from './analyzers/haiku.js';
import { scoreIdea } from './analyzers/sonnet.js';
import { tavilySearch, type TavilySearchResult } from './lib/tavily.js';
import {
  HaikuSignalInputSchema,
  type HaikuIdeaCandidate,
  type IdeaCategory,
  type SonnetScoredIdea,
} from './types.js';

const WINDOW_HOURS = 12;
const MAX_SIGNALS_PER_BATCH = 500;
const SONNET_TOP_N = 10;
const INSERT_TOP_N = 5;

// Tavily の無料プランで明示的な per-second レート制限は公表されていないが、
// 10 req/バッチを数秒間隔で叩く保険として 300ms の最小間隔を置く。
const SEARCH_MIN_INTERVAL_MS = 300;

const CATEGORY_EN: Record<IdeaCategory, string> = {
  'dev-tool': 'developer tool',
  productivity: 'productivity app',
  saas: 'saas',
  ai: 'ai tool',
  other: '',
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sum3(s: SonnetScoredIdea): number {
  return s.market_score + s.tech_score + s.competition_score;
}

interface SignalRow {
  id: string;
  source: string;
  title: string;
  content: string | null;
  url: string;
}

async function fetchUnprocessedSignals(): Promise<SignalRow[]> {
  const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('raw_signals')
    .select('id, source, title, content, url')
    .eq('processed', false)
    .gte('collected_at', since)
    .order('collected_at', { ascending: false })
    .limit(MAX_SIGNALS_PER_BATCH);
  if (error) throw error;
  return (data ?? []) as SignalRow[];
}

// SignalRow → Haiku 入力形式 (zod でバリデートしてから配列化)。
// 異常データはログに出してスキップ。
function toHaikuInputs(rows: SignalRow[]): ReturnType<typeof HaikuSignalInputSchema.parse>[] {
  const out: ReturnType<typeof HaikuSignalInputSchema.parse>[] = [];
  for (const r of rows) {
    const parsed = HaikuSignalInputSchema.safeParse(r);
    if (!parsed.success) {
      console.warn(`[analyze] drop invalid signal ${r.id}: ${parsed.error.message}`);
      continue;
    }
    out.push(parsed.data);
  }
  return out;
}

async function scoreTopCandidates(
  candidates: HaikuIdeaCandidate[],
): Promise<SonnetScoredIdea[]> {
  const top = [...candidates]
    .sort((a, b) => b.raw_score - a.raw_score)
    .slice(0, SONNET_TOP_N);

  console.log(`[analyze] sonnet_top=${top.length}`);

  const scored: SonnetScoredIdea[] = [];
  let lastSearchAt = 0;

  for (const c of top) {
    const wait = lastSearchAt + SEARCH_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);

    let hits: TavilySearchResult[] = [];
    try {
      const q = `${c.title} ${CATEGORY_EN[c.category]}`.trim();
      hits = await tavilySearch(q, 5);
      console.log(`[tavily] q="${q}" hits=${hits.length}`);
    } catch (err) {
      console.warn(
        `[tavily] failed for "${c.title}":`,
        err instanceof Error ? err.message : err,
      );
    }
    lastSearchAt = Date.now();

    try {
      const result = await scoreIdea(c, hits);
      scored.push(result);
    } catch (err) {
      console.error(
        `[analyze] sonnet failed for "${c.title}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return scored;
}

function toIdeaRow(s: SonnetScoredIdea): Record<string, unknown> {
  return {
    title: s.title,
    pain_summary: s.pain_summary,
    idea_description: s.idea_description,
    category: s.category,
    market_score: s.market_score,
    tech_score: s.tech_score,
    competition_score: s.competition_score,
    competitors: s.competitors,
    source_signal_ids: s.source_signal_ids,
  };
}

async function main(): Promise<void> {
  console.log(
    `[analyze] window=${WINDOW_HOURS}h, started=${new Date().toISOString()}`,
  );

  const rows = await fetchUnprocessedSignals();
  console.log(`[analyze] unprocessed_signals=${rows.length}`);
  if (rows.length === 0) {
    console.log('[analyze] nothing to analyze, exiting');
    return;
  }

  const signals = toHaikuInputs(rows);
  if (signals.length === 0) {
    console.log('[analyze] no valid signals after parse, exiting');
    return;
  }

  const candidates = await extractIdeas(signals);
  console.log(`[analyze] haiku candidates=${candidates.length}`);
  if (candidates.length === 0) {
    // Haiku が候補 0 を返しても、この 12h のシグナルは「処理済み」とみなす
    await markProcessed(signals.map((s) => s.id));
    console.log('[analyze] no candidates, signals marked processed');
    return;
  }

  const scored = await scoreTopCandidates(candidates);
  console.log(`[analyze] sonnet_scored=${scored.length}`);

  const finals = [...scored]
    .sort((a, b) => sum3(b) - sum3(a))
    .slice(0, INSERT_TOP_N);

  if (finals.length > 0) {
    const { error: insErr } = await supabase.from('ideas').insert(finals.map(toIdeaRow));
    if (insErr) {
      console.error('[analyze] ideas insert failed:', insErr);
      process.exit(1);
    }
    console.log(`[analyze] ideas_inserted=${finals.length}`);
  } else {
    console.log('[analyze] no finals to insert');
  }

  await markProcessed(signals.map((s) => s.id));
  console.log(`[analyze] done=${new Date().toISOString()}`);
}

async function markProcessed(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  // Supabase の .in() は 1 クエリあたりの id 数に実用的な制限がある (URI 長) ため、
  // 500 件なら 1 クエリで十分だが安全のため 200 件ずつに分割。
  const BATCH = 200;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const { error } = await supabase
      .from('raw_signals')
      .update({ processed: true })
      .in('id', slice);
    if (error) {
      console.error(`[analyze] mark processed failed (batch ${i}):`, error);
      // processed 更新失敗は次回バッチで再処理されてしまうので exit 1 扱い
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('[analyze] unhandled:', err);
  process.exit(1);
});
