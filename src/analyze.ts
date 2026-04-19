// 日次バッチの分析パイプライン:
//   1. raw_signals (未処理 / 直近 24h) を取得
//   2. Haiku クラスタリング: aggregator_bundles (≥3) / combinator_pairs (≥2) / gap_candidates (≥1)
//   3. Sonnet × 3 役割並列: 集約者 / 結合者 / 隙間発見者 がそれぞれアイデアを起草
//   4. 合流して raw_score DESC で Top 10
//   5. Top 10 を Tavily 検索 + Sonnet 3 軸スコアリング
//   6. Top 5 を ideas に insert、signals を processed=true 更新
//
// 3 役割アプローチの意図: 「ハッカソンで 3 人が集まってブレストする」発想で
// 異なる視点 (複数シグナル集約 / 痛み×技術掛け合わせ / 既存プロダクトの隙間) から
// アイデアを起草することで、単一視点ドラフトよりも厚みのあるアイデアを得る。

import 'dotenv/config';
import { supabase } from './db/supabase.js';
import { clusterSignals } from './analyzers/haiku.js';
import { draftFromAggregatorBundle } from './analyzers/sonnet-aggregator.js';
import { draftFromCombinatorPair } from './analyzers/sonnet-combinator.js';
import { draftFromGapCandidate } from './analyzers/sonnet-gap-finder.js';
import { scoreIdea } from './analyzers/sonnet.js';
import { tavilySearch, type TavilySearchResult } from './lib/tavily.js';
import {
  HaikuSignalInputSchema,
  HnStoryTypeSchema,
  type HaikuIdeaCandidate,
  type HaikuSignalInput,
  type IdeaCategory,
  type IdeaRole,
  type RoleTaggedCandidate,
  type SonnetScoredIdea,
} from './types.js';

const WINDOW_HOURS = 24;
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
  metadata: Record<string, unknown> | null;
}

async function fetchUnprocessedSignals(): Promise<SignalRow[]> {
  const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('raw_signals')
    .select('id, source, title, content, url, metadata')
    .eq('processed', false)
    .gte('collected_at', since)
    .order('collected_at', { ascending: false })
    .limit(MAX_SIGNALS_PER_BATCH);
  if (error) throw error;
  return (data ?? []) as SignalRow[];
}

// SignalRow → Haiku 入力形式 (zod でバリデートしてから配列化)。
// HN の metadata.story_type は Haiku プロンプトで参照させるので hn_story_type に昇格。
// 異常データはログに出してスキップ。
function toHaikuInputs(rows: SignalRow[]): HaikuSignalInput[] {
  const out: HaikuSignalInput[] = [];
  for (const r of rows) {
    const enriched: Record<string, unknown> = {
      id: r.id,
      source: r.source,
      title: r.title,
      content: r.content,
      url: r.url,
    };
    if (r.source === 'hackernews' && r.metadata) {
      const parsed = HnStoryTypeSchema.safeParse(r.metadata.story_type);
      if (parsed.success) enriched.hn_story_type = parsed.data;
    }
    const parsed = HaikuSignalInputSchema.safeParse(enriched);
    if (!parsed.success) {
      console.warn(`[analyze] drop invalid signal ${r.id}: ${parsed.error.message}`);
      continue;
    }
    out.push(parsed.data);
  }
  return out;
}

// 3 役割を並列で起草させ、全候補を role タグ付きで返す。
// 1 つの役割がコケても他は生かす (Promise.allSettled 相当の扱い)。
async function draftByThreeRoles(
  cluster: Awaited<ReturnType<typeof clusterSignals>>,
  signals: HaikuSignalInput[],
): Promise<RoleTaggedCandidate[]> {
  const signalsById = new Map(signals.map((s) => [s.id, s] as const));

  const runRole = async (
    role: IdeaRole,
    drafter: () => Promise<HaikuIdeaCandidate[][]>,
  ): Promise<RoleTaggedCandidate[]> => {
    try {
      const perInput = await drafter();
      const flat = perInput.flat();
      const tagged = flat.map((c) => ({ ...c, role }));
      console.log(`[analyze] role=${role} drafted=${tagged.length}`);
      return tagged;
    } catch (err) {
      console.error(
        `[analyze] role=${role} failed (all inputs lost):`,
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  };

  // 各入力が独立なので内部も Promise.allSettled で 1 個コケてもロール全体は落とさない
  const safeMap = async <I>(
    items: I[],
    fn: (item: I) => Promise<HaikuIdeaCandidate[]>,
    label: string,
  ): Promise<HaikuIdeaCandidate[][]> => {
    const results = await Promise.allSettled(items.map(fn));
    const out: HaikuIdeaCandidate[][] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') out.push(r.value);
      else
        console.warn(
          `[analyze] ${label} one input failed:`,
          r.reason instanceof Error ? r.reason.message : r.reason,
        );
    }
    return out;
  };

  const [aggregator, combinator, gapFinder] = await Promise.all([
    runRole('aggregator', () =>
      safeMap(
        cluster.aggregator_bundles,
        (bundle) => draftFromAggregatorBundle({ bundle, signalsById }),
        'aggregator',
      ),
    ),
    runRole('combinator', () =>
      safeMap(
        cluster.combinator_pairs,
        (pair) => draftFromCombinatorPair({ pair, signalsById }),
        'combinator',
      ),
    ),
    runRole('gap_finder', () =>
      safeMap(
        cluster.gap_candidates,
        (candidate) => draftFromGapCandidate({ candidate, signalsById }),
        'gap_finder',
      ),
    ),
  ]);

  return [...aggregator, ...combinator, ...gapFinder];
}

async function scoreTopCandidates(
  candidates: RoleTaggedCandidate[],
): Promise<Array<SonnetScoredIdea & { role: IdeaRole }>> {
  const top = [...candidates]
    .sort((a, b) => b.raw_score - a.raw_score)
    .slice(0, SONNET_TOP_N);

  const roleCount = top.reduce<Record<IdeaRole, number>>(
    (acc, c) => {
      acc[c.role] = (acc[c.role] ?? 0) + 1;
      return acc;
    },
    { aggregator: 0, combinator: 0, gap_finder: 0 },
  );
  console.log(
    `[analyze] sonnet_top=${top.length} by_role aggregator=${roleCount.aggregator} combinator=${roleCount.combinator} gap_finder=${roleCount.gap_finder}`,
  );

  const scored: Array<SonnetScoredIdea & { role: IdeaRole }> = [];
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
      scored.push({ ...result, role: c.role });
    } catch (err) {
      console.error(
        `[analyze] sonnet score failed for "${c.title}":`,
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

  // 1) Haiku クラスタリング
  const cluster = await clusterSignals(signals);
  const totalClusterInputs =
    cluster.aggregator_bundles.length +
    cluster.combinator_pairs.length +
    cluster.gap_candidates.length;
  if (totalClusterInputs === 0) {
    // クラスタリング結果 0 件でもこのバッチのシグナルは処理済みとみなす
    await markProcessed(signals.map((s) => s.id));
    console.log('[analyze] no clusters, signals marked processed');
    return;
  }

  // 2) Sonnet × 3 役割並列でアイデア起草
  const candidates = await draftByThreeRoles(cluster, signals);
  console.log(`[analyze] total_drafted=${candidates.length}`);
  if (candidates.length === 0) {
    await markProcessed(signals.map((s) => s.id));
    console.log('[analyze] no drafts, signals marked processed');
    return;
  }

  // 3) Top 10 を Tavily + Sonnet 3 軸スコアリング
  const scored = await scoreTopCandidates(candidates);
  console.log(`[analyze] sonnet_scored=${scored.length}`);

  // 4) 合計スコアで Top 5
  const finals = [...scored]
    .sort((a, b) => sum3(b) - sum3(a))
    .slice(0, INSERT_TOP_N);

  if (finals.length > 0) {
    const roleDist = finals.reduce<Record<IdeaRole, number>>(
      (acc, f) => {
        acc[f.role] = (acc[f.role] ?? 0) + 1;
        return acc;
      },
      { aggregator: 0, combinator: 0, gap_finder: 0 },
    );
    console.log(
      `[analyze] finals_by_role aggregator=${roleDist.aggregator} combinator=${roleDist.combinator} gap_finder=${roleDist.gap_finder}`,
    );

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
