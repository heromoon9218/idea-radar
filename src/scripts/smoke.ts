// 認証不要なコレクタ / 認証必要な analyze パイプラインのスモークテスト。
// 使い方:
//   npx tsx src/scripts/smoke.ts                 # コレクタ 3 種を dry-run (認証不要)
//   npx tsx src/scripts/smoke.ts --analyze       # Haiku cluster / 3 Sonnet 役割 / Tavily / Sonnet score を 1 件だけ通電確認
//                                                (要 ANTHROPIC_API_KEY, TAVILY_API_KEY,
//                                                 SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
//   npx tsx src/scripts/smoke.ts --deliver-dry   # 未配信 ideas から Markdown を生成して stdout。
//                                                  メール送信 / DB 書き込み / ファイル出力はしない
//                                                  (要 SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

import 'dotenv/config';
import { collectHatena } from '../collectors/hatena.js';
import { collectZenn } from '../collectors/zenn.js';
import { collectHackerNews } from '../collectors/hackernews.js';
import { collectStackExchange } from '../collectors/stackexchange.js';
import { clusterSignals } from '../analyzers/haiku.js';
import {
  buildDemandSummary,
  logLineDemandSummary,
} from '../analyzers/demand-summary.js';
import { draftFromAggregatorBundle } from '../analyzers/sonnet-aggregator.js';
import { draftFromCombinatorPair } from '../analyzers/sonnet-combinator.js';
import { draftFromGapCandidate } from '../analyzers/sonnet-gap-finder.js';
import { scoreIdea, type TavilyStatus } from '../analyzers/sonnet.js';
import {
  computeWeightedScore,
  describeBandConfig,
} from '../lib/goal-band.js';
import { tavilySearch } from '../lib/tavily.js';
import { supabase } from '../db/supabase.js';
import {
  HaikuSignalInputSchema,
  HnStoryTypeSchema,
  SourceTypeSchema,
  type HaikuIdeaCandidate,
  type HaikuSignalInput,
  type IdeaRole,
  type RawSignalInput,
  type SourceType,
} from '../types.js';
import {
  attachSourceLinks,
  fetchUndeliveredTopIdeas,
} from '../report/select-ideas.js';
import { renderMarkdown } from '../report/render-markdown.js';
import { markdownToHtml } from '../report/markdown-to-html.js';
import { buildSubject, resolveSlotBase } from '../report/slot.js';

const WINDOW_MIN = 1440; // 過去24h
// analyze smoke はクラスタリングの精度確認もしたいので多めに取る (通常運用と同等の入力量)
const ANALYZE_SAMPLE_SIZE = 50;

type SmokeCollector = readonly [string, () => Promise<RawSignalInput[]>];

async function smokeCollectors(): Promise<void> {
  const collectors: readonly SmokeCollector[] = [
    ['hatena', () => collectHatena(WINDOW_MIN)],
    ['zenn', () => collectZenn(WINDOW_MIN)],
    ['hackernews', () => collectHackerNews(WINDOW_MIN, { normalTopByScore: 100 })],
    ['stackexchange', () => collectStackExchange(WINDOW_MIN)],
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

// 新パイプライン (Haiku cluster + 3 Sonnet 役割) を 1 件ずつだけ通電確認する。
// 3 役割それぞれ「最初の 1 入力」のみドラフト → 出力されたアイデアのうち 1 件を
// Tavily + Sonnet スコアリングまで通す。本番の analyze.ts より軽量な dry-run。
async function smokeAnalyze(): Promise<void> {
  const bandConfig = describeBandConfig();
  console.log(`[smoke-analyze] sample_size=${ANALYZE_SAMPLE_SIZE} ${bandConfig.logLine}`);

  // 1) DB からサンプル signals を取得 (processed 問わず最新を拾う)
  const { data, error } = await supabase
    .from('raw_signals')
    .select('id, source, title, content, url, metadata')
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
  const metadataById = new Map<
    string,
    { source: SourceType; metadata: Record<string, unknown> | null }
  >();
  for (const r of rows) {
    const enriched: Record<string, unknown> = {
      id: r.id,
      source: r.source,
      title: r.title,
      content: r.content,
      url: r.url,
    };
    if (r.source === 'hackernews' && r.metadata) {
      const parsed = HnStoryTypeSchema.safeParse(
        (r.metadata as Record<string, unknown>).story_type,
      );
      if (parsed.success) enriched.hn_story_type = parsed.data;
    }
    if (r.source === 'stackexchange' && r.metadata) {
      const site = (r.metadata as Record<string, unknown>).se_site;
      if (typeof site === 'string' && site.length > 0) enriched.se_site = site;
    }
    const parsed = HaikuSignalInputSchema.safeParse(enriched);
    if (!parsed.success) {
      console.warn(`[smoke-analyze] drop invalid signal ${r.id}: ${parsed.error.message}`);
      continue;
    }
    signals.push(parsed.data);
    const src = SourceTypeSchema.safeParse(r.source);
    if (src.success) {
      metadataById.set(r.id, {
        source: src.data,
        metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      });
    }
  }
  if (signals.length === 0) {
    console.log('[smoke-analyze] no valid signals, aborting');
    return;
  }
  const signalsById = new Map(signals.map((s) => [s.id, s] as const));

  // 2) Haiku クラスタリング
  const cluster = await clusterSignals(signals);
  console.log(
    `[smoke-analyze] aggregator_bundles=${cluster.aggregator_bundles.length} combinator_pairs=${cluster.combinator_pairs.length} gap_candidates=${cluster.gap_candidates.length}`,
  );

  // 3) 各役割 最初の 1 入力だけドラフト
  const drafted: Array<HaikuIdeaCandidate & { role: IdeaRole }> = [];

  const firstAgg = cluster.aggregator_bundles[0];
  if (firstAgg) {
    try {
      const summary = buildDemandSummary(firstAgg.signal_ids, metadataById);
      console.log(logLineDemandSummary(`aggregator theme="${firstAgg.theme.slice(0, 30)}"`, summary));
      const cands = await draftFromAggregatorBundle({
        bundle: firstAgg,
        signalsById,
        demandSummary: summary,
      });
      console.log(`[smoke-analyze] aggregator drafted=${cands.length}`);
      for (const c of cands) drafted.push({ ...c, role: 'aggregator' });
    } catch (err) {
      console.warn('[smoke-analyze] aggregator failed:', err instanceof Error ? err.message : err);
    }
  } else {
    console.log('[smoke-analyze] no aggregator_bundle in sample, skipping');
  }

  const firstCom = cluster.combinator_pairs[0];
  if (firstCom) {
    try {
      const painSummary = buildDemandSummary(firstCom.pain_signal_ids, metadataById);
      const infoSummary = buildDemandSummary(firstCom.info_signal_ids, metadataById);
      console.log(logLineDemandSummary(`combinator pain angle="${firstCom.angle.slice(0, 30)}"`, painSummary));
      console.log(logLineDemandSummary(`combinator info angle="${firstCom.angle.slice(0, 30)}"`, infoSummary));
      const cands = await draftFromCombinatorPair({
        pair: firstCom,
        signalsById,
        painDemandSummary: painSummary,
        infoDemandSummary: infoSummary,
      });
      console.log(`[smoke-analyze] combinator drafted=${cands.length}`);
      for (const c of cands) drafted.push({ ...c, role: 'combinator' });
    } catch (err) {
      console.warn('[smoke-analyze] combinator failed:', err instanceof Error ? err.message : err);
    }
  } else {
    console.log('[smoke-analyze] no combinator_pair in sample, skipping');
  }

  const firstGap = cluster.gap_candidates[0];
  if (firstGap) {
    try {
      const summary = buildDemandSummary(firstGap.signal_ids, metadataById);
      console.log(logLineDemandSummary(`gap_finder angle=${firstGap.angle}`, summary));
      const cands = await draftFromGapCandidate({
        candidate: firstGap,
        signalsById,
        demandSummary: summary,
      });
      console.log(`[smoke-analyze] gap_finder drafted=${cands.length}`);
      for (const c of cands) drafted.push({ ...c, role: 'gap_finder' });
    } catch (err) {
      console.warn('[smoke-analyze] gap_finder failed:', err instanceof Error ? err.message : err);
    }
  } else {
    console.log('[smoke-analyze] no gap_candidate in sample, skipping');
  }

  if (drafted.length === 0) {
    console.log('[smoke-analyze] no drafts produced, stopping');
    return;
  }

  console.log(`[smoke-analyze] drafts_total=${drafted.length}`);

  // 4) 最上位 1 件だけ Tavily + Sonnet スコアリングを通電
  const top = [...drafted].sort((a, b) => b.raw_score - a.raw_score)[0]!;
  console.log(`[smoke-analyze] top role=${top.role} title="${top.title}"`);
  console.log(JSON.stringify(top, null, 2));

  let hits: Awaited<ReturnType<typeof tavilySearch>> = [];
  let status: TavilyStatus = 'ok';
  try {
    hits = await tavilySearch(top.title, 5);
    status = hits.length === 0 ? 'empty' : 'ok';
    console.log(`[smoke-analyze] tavily_hits=${hits.length} status=${status}`);
  } catch (err) {
    status = 'failed';
    console.warn('[smoke-analyze] tavily failed status=failed:', err instanceof Error ? err.message : err);
  }

  const scored = await scoreIdea(top, hits, status, {
    band: bandConfig.band,
    targetMrr: bandConfig.targetMrr,
  });
  const weighted = computeWeightedScore(scored, bandConfig.weights);
  console.log('[smoke-analyze] sonnet_score_output:');
  console.log(JSON.stringify(scored, null, 2));
  console.log(
    `[smoke-analyze] total_score=${
      scored.market_score + scored.tech_score + scored.competition_score
    }/15 weighted_score=${weighted.toFixed(2)} band=${bandConfig.band}`,
  );
}

async function smokeDeliverDry(): Promise<void> {
  const ideas = await fetchUndeliveredTopIdeas();
  console.log(`[smoke-deliver] undelivered=${ideas.length}`);
  if (ideas.length === 0) {
    console.log('[smoke-deliver] 0 件 (通常運用なら skip)');
    return;
  }

  const enriched = await attachSourceLinks(ideas);
  const base = resolveSlotBase(new Date());
  const subject = buildSubject(base, enriched.length);
  const markdown = renderMarkdown(enriched, { date: base.date, slotLabel: base.slotLabel });
  const html = markdownToHtml(markdown, subject);

  console.log('=== subject ===');
  console.log(subject);
  console.log('=== markdown ===');
  console.log(markdown);
  console.log('=== html (first 1200 chars) ===');
  console.log(html.slice(0, 1200));
}

async function main(): Promise<void> {
  if (process.argv.includes('--analyze')) {
    await smokeAnalyze();
    return;
  }
  if (process.argv.includes('--deliver-dry')) {
    await smokeDeliverDry();
    return;
  }
  await smokeCollectors();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
