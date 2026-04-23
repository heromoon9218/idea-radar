// 日次バッチの分析パイプライン (Sprint B 反映版):
//   1. raw_signals (未処理 / 直近 24h) を取得
//   2. Haiku クラスタリング: aggregator_bundles (≥3) / combinator_pairs (≥2) / gap_candidates (≥1)
//   3. Sonnet × 3 役割並列: 集約者 / 結合者 / 隙間発見者 がそれぞれアイデアを起草
//      (各役割内は DRAFT_CONCURRENCY で同時実行数を制限、B-3 で fermi_estimate を必須化)
//   4. 合流 → 役割間で title+category 一致するアイデアを dedup
//   5. raw_score DESC で Top 10 → 1 件ずつ:
//        a. Tavily 並列検索 (英語 / 日本語 / 機能語の最大 3 クエリ union) [B-4]
//        b. Sonnet 3 軸スコアリング (初回)
//        c. 赤旗スキャン (risk_auditor) + Devil's advocate 2-pass 再スコア を Promise.all [B-1/B-2]
//        d. 再スコアを採用、reasoning は devils_advocate jsonb へ保持
//   6. tech_score 足切り → weighted_score DESC で Top 5 を ideas に insert
//   7. signals を processed=true 更新
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
import { auditRisks } from './analyzers/sonnet-risk-auditor.js';
import { critiqueAndRescore } from './analyzers/sonnet-devils-advocate.js';
import {
  buildDemandSummary,
  logLineDemandSummary,
  type DemandSummary,
} from './analyzers/demand-summary.js';
import { scoreIdea, type TavilyStatus } from './analyzers/sonnet.js';
import { mapWithLimit } from './lib/concurrency.js';
import {
  computeWeightedScore,
  describeBandConfig,
  TECH_SCORE_MIN,
  type BandConfig,
} from './lib/goal-band.js';
import { searchParallel, type TavilySearchResult } from './lib/tavily.js';
import {
  HaikuSignalInputSchema,
  HnStoryTypeSchema,
  SourceTypeSchema,
  type DevilsAdvocatePersisted,
  type FermiEstimate,
  type HaikuIdeaCandidate,
  type HaikuSignalInput,
  type IdeaCategory,
  type IdeaRole,
  type RiskFlag,
  type RoleTaggedCandidate,
  type SonnetScoredIdea,
  type SourceType,
} from './types.js';

const WINDOW_HOURS = 24;
// 現行 4 ソースの日次件数内訳:
//   hatena (~38) + zenn (~100) + HN 非 normal (~75) + HN normal top 100 + stackexchange 3 サイト (~30-60)
//   = 約 340-400 件。Sprint C で note/reddit を stackexchange に入れ替え済み。
// 上限を 700 に置いているのは、HN normal フィルタの閾値引き上げや SE サイト追加で増える余地を残すため。
// Haiku のコンテキストウィンドウは 200k+ で余裕があり、Sonnet × 3 役割は Top 10 のみがコスト対象なので
// signal 数増加がコストに線形比例しないため、上限引き上げは安全。
const MAX_SIGNALS_PER_BATCH = 700;
const SONNET_TOP_N = 10;
const INSERT_TOP_N = 5;

// Sonnet drafter の同時実行数上限 (役割内)。
// 3 役割を Promise.all で並列に走らせるので、理論最大は 3 × DRAFT_CONCURRENCY 件。
// 値を 1 にしている理由:
//   Sonnet 4.6 は organization 単位で 8,000 output tokens/min の TPM 制限があり、
//   役割内 concurrency=3 (= 合計 9 並列) だと max_tokens=3072 のドラフトが同時発火して
//   429 rate_limit_error を頻発する (実測: 2026-04-20 の analyze で combinator/gap_finder
//   共に 4-5 回 429)。concurrency=1 にすると役割内は完全逐次になり、3 役割並列でも
//   同時リクエストは 3 に収まる。1 ドラフトは ~20-40s かかるが、バンドル数は各役割
//   10-20 件程度なので analyze 全体は 10-15min の timeout に収まる。
//   副次効果: 逐次実行により prompt cache (ephemeral) の書き込み → 読み取りが確実に
//   ヒットし、2 件目以降のコストが 10% になる。
const DRAFT_CONCURRENCY = 1;

// Tavily の無料プランで明示的な per-second レート制限は公表されていないが、
// 10 req/バッチを数秒間隔で叩く保険として 300ms の最小間隔を置く。
const SEARCH_MIN_INTERVAL_MS = 300;

// Sprint B-4: 1 candidate あたり最大クエリ数。
// 無料枠は 1,000 req/月なので SONNET_TOP_N (10) × MAX_QUERIES_PER_CANDIDATE (3) × 30 日 = 900 req/月 が上限。
// 引き上げる場合は月間 req 数を再計算し、有料プラン移行 or TOP_N 削減が必要になる。
const MAX_QUERIES_PER_CANDIDATE = 3;

const CATEGORY_EN: Record<IdeaCategory, string> = {
  'dev-tool': 'developer tool',
  productivity: 'productivity app',
  saas: 'saas',
  ai: 'ai tool',
  other: '',
};

// 日本語カテゴリ名 (Tavily 日本語クエリ用)。英語よりも日本市場の類似サービスを拾いやすい。
const CATEGORY_JA_FOR_QUERY: Record<IdeaCategory, string> = {
  'dev-tool': '開発者向けツール',
  productivity: '生産性',
  saas: 'SaaS',
  ai: 'AI',
  other: '',
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ScoredWithWeight extends SonnetScoredIdea {
  role: IdeaRole;
  weighted_score: number;
  fermi_estimate: FermiEstimate;
  risk_flags: RiskFlag[];
  devils_advocate: DevilsAdvocatePersisted;
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
// Stack Exchange の metadata.se_site も同様に se_site に昇格 (サイトごとに痛みの領域が異なるため)。
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
    if (r.source === 'stackexchange' && r.metadata) {
      const site = r.metadata.se_site;
      if (typeof site === 'string' && site.length > 0) enriched.se_site = site;
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
// metadataById は bundle 単位の需要シグナルサマリ (bkm / HN score 等) 計算用。
async function draftByThreeRoles(
  cluster: Awaited<ReturnType<typeof clusterSignals>>,
  signals: HaikuSignalInput[],
  metadataById: Map<string, { source: SourceType; metadata: Record<string, unknown> | null }>,
): Promise<RoleTaggedCandidate[]> {
  const signalsById = new Map(signals.map((s) => [s.id, s] as const));

  // 各バンドルの demand_summary を事前計算して drafter に渡す。null 可。
  const summarize = (ids: string[], label: string): DemandSummary | null => {
    const s = buildDemandSummary(ids, metadataById);
    console.log(logLineDemandSummary(label, s));
    return s;
  };

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

  // 各入力が独立なので mapWithLimit で concurrency を絞りつつ、allSettled 相当の
  // semantics で 1 個コケてもロール全体は落とさない。
  const safeMap = async <I>(
    items: I[],
    fn: (item: I) => Promise<HaikuIdeaCandidate[]>,
    label: string,
  ): Promise<HaikuIdeaCandidate[][]> => {
    const results = await mapWithLimit(items, DRAFT_CONCURRENCY, fn);
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
        (bundle) =>
          draftFromAggregatorBundle({
            bundle,
            signalsById,
            demandSummary: summarize(bundle.signal_ids, `aggregator theme="${bundle.theme.slice(0, 30)}"`),
          }),
        'aggregator',
      ),
    ),
    runRole('combinator', () =>
      safeMap(
        cluster.combinator_pairs,
        (pair) =>
          draftFromCombinatorPair({
            pair,
            signalsById,
            painDemandSummary: summarize(pair.pain_signal_ids, `combinator pain angle="${pair.angle.slice(0, 30)}"`),
            infoDemandSummary: summarize(pair.info_signal_ids, `combinator info angle="${pair.angle.slice(0, 30)}"`),
          }),
        'combinator',
      ),
    ),
    runRole('gap_finder', () =>
      safeMap(
        cluster.gap_candidates,
        (candidate) =>
          draftFromGapCandidate({
            candidate,
            signalsById,
            demandSummary: summarize(candidate.signal_ids, `gap_finder angle=${candidate.angle}`),
          }),
        'gap_finder',
      ),
    ),
  ]);

  return [...aggregator, ...combinator, ...gapFinder];
}

// 役割間で title + category が完全一致するアイデアをマージ。
// 同じシグナルが aggregator と gap に跨って採用されるケースで、Sonnet が
// 似たアイデアを 2 本出すのを吸収する。raw_score が高い方を残し、
// source_signal_ids は両者の和集合にする (片方だけが知っている ID を取りこぼさない)。
// 同点なら先に出現した方の role を残す (安定ソート性)。
function dedupeCandidates(
  candidates: RoleTaggedCandidate[],
): RoleTaggedCandidate[] {
  const byKey = new Map<string, RoleTaggedCandidate>();
  for (const c of candidates) {
    const key = `${c.category}|${c.title.trim().toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, c);
      continue;
    }
    const mergedIds = Array.from(
      new Set([...existing.source_signal_ids, ...c.source_signal_ids]),
    );
    const winner = c.raw_score > existing.raw_score ? c : existing;
    byKey.set(key, { ...winner, source_signal_ids: mergedIds });
  }
  return Array.from(byKey.values());
}

// Sprint B-4: candidate 1 件に対して最大 MAX_QUERIES_PER_CANDIDATE 本のクエリを作る。
// - 英語: title + category (現行クエリ、英語圏競合を拾う)
// - 日本語: title + "競合" 等、日本語カテゴリ併記 (日本市場の類似サービス)
// - 機能語: what から主要な機能/動詞フレーズを短く抜き出して英語化
//   (抽出が難しい場合はスキップして 2 本運用)
function buildTavilyQueries(c: RoleTaggedCandidate): string[] {
  const queries: string[] = [];
  const en = `${c.title} ${CATEGORY_EN[c.category]}`.trim();
  if (en.length > 0) queries.push(en);

  // 日本語クエリは title をそのまま使い、カテゴリ日本語名 + "類似サービス" を添える。
  // title が既に日本語でも英語でも Tavily は言語自動判定するので害はない。
  const jaCategory = CATEGORY_JA_FOR_QUERY[c.category];
  const jaParts = [c.title, jaCategory, '類似サービス']
    .filter((s) => s && s.length > 0);
  const ja = jaParts.join(' ');
  if (ja.length > 0) queries.push(ja);

  // 機能語: what の先頭 60 文字 → 句点で打ち切り → 末尾の「〜する/〜できる/〜したい」
  // と残り助詞を軽く削って名詞寄りのフレーズを残す。LLM パースは入れずヒューリスティック運用。
  // title と同一になった場合は 3 本目を発行しない (2 本運用にフォールバック)。
  const firstSentence = c.what.slice(0, 60).replace(/[。\.].*$/, '').trim();
  const featureSeed = firstSentence
    .replace(/(できる|する|したい)(機能|こと|ツール|アプリ)?$/u, '')
    .replace(/[をがはにで]$/u, '')
    .trim();
  if (featureSeed.length > 0 && featureSeed !== c.title) {
    queries.push(`${featureSeed} ${CATEGORY_EN[c.category]}`.trim());
  }

  return queries.slice(0, MAX_QUERIES_PER_CANDIDATE);
}

async function scoreTopCandidates(
  candidates: RoleTaggedCandidate[],
  bandConfig: BandConfig,
): Promise<ScoredWithWeight[]> {
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

  const scored: ScoredWithWeight[] = [];
  let lastSearchAt = 0;

  for (const c of top) {
    const wait = lastSearchAt + SEARCH_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);

    // Sprint B-4: 2-3 本並列検索で日本語競合も拾う。
    const queries = buildTavilyQueries(c);
    let hits: TavilySearchResult[] = [];
    let status: TavilyStatus = 'ok';
    try {
      const parallel = await searchParallel(queries, 5, 8);
      hits = parallel.results;
      status = parallel.status;
      console.log(
        `[tavily] queries=${parallel.queriesAttempted} failed=${parallel.queriesFailed} hits=${hits.length} status=${status} title="${c.title.slice(0, 40)}"`,
      );
    } catch (err) {
      status = 'failed';
      console.warn(
        `[tavily] parallel unexpected error for "${c.title}" status=failed:`,
        err instanceof Error ? err.message : err,
      );
    }
    lastSearchAt = Date.now();

    let initial: SonnetScoredIdea;
    try {
      initial = await scoreIdea(c, hits, status, {
        band: bandConfig.band,
        targetMrr: bandConfig.targetMrr,
      });
    } catch (err) {
      console.error(
        `[analyze] sonnet score failed for "${c.title}":`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    // Sprint B-1 / B-2: リスク監査 + Devil's advocate 2-pass を並列実行。
    // いずれも初回スコアに依存するが、互いには独立なので Promise.all で同時発火。
    // どちらかが失敗しても他方は生かす (allSettled)。
    const [riskSettled, devilSettled] = await Promise.allSettled([
      auditRisks({ candidate: initial }),
      critiqueAndRescore(initial, {
        band: bandConfig.band,
        targetMrr: bandConfig.targetMrr,
      }),
    ]);

    const risk_flags: RiskFlag[] =
      riskSettled.status === 'fulfilled' ? riskSettled.value : [];
    if (riskSettled.status === 'rejected') {
      console.warn(
        `[analyze] risk_audit failed for "${c.title}":`,
        riskSettled.reason instanceof Error ? riskSettled.reason.message : riskSettled.reason,
      );
    } else {
      const highCount = risk_flags.filter((f) => f.severity === 'high').length;
      console.log(
        `[analyze] risk_flags count=${risk_flags.length} high=${highCount} title="${c.title.slice(0, 40)}"`,
      );
    }

    // Devil's advocate が失敗した場合は初回スコアをそのまま採用する (保守動作)
    let finalMarket = initial.market_score;
    let finalTech = initial.tech_score;
    let finalComp = initial.competition_score;
    let devils_advocate: DevilsAdvocatePersisted = {
      rejection_reasons: [],
      verdict: 'devils_advocate 呼び出しが失敗 / スキップされたため初回スコアをそのまま採用',
      initial_scores: {
        market: initial.market_score,
        tech: initial.tech_score,
        competition: initial.competition_score,
      },
    };
    if (devilSettled.status === 'fulfilled') {
      const d = devilSettled.value;
      finalMarket = d.reconsidered_market_score;
      finalTech = d.reconsidered_tech_score;
      finalComp = d.reconsidered_competition_score;
      devils_advocate = {
        rejection_reasons: d.rejection_reasons,
        verdict: d.verdict,
        initial_scores: {
          market: initial.market_score,
          tech: initial.tech_score,
          competition: initial.competition_score,
        },
      };
      const delta =
        (finalMarket - initial.market_score) +
        (finalTech - initial.tech_score) +
        (finalComp - initial.competition_score);
      console.log(
        `[analyze] devils_advocate title="${c.title.slice(0, 40)}" reasons=${d.rejection_reasons.length} delta_sum=${delta >= 0 ? '+' : ''}${delta}`,
      );
    } else {
      console.warn(
        `[analyze] devils_advocate failed for "${c.title}":`,
        devilSettled.reason instanceof Error ? devilSettled.reason.message : devilSettled.reason,
      );
    }

    const final: SonnetScoredIdea = {
      ...initial,
      market_score: finalMarket,
      tech_score: finalTech,
      competition_score: finalComp,
    };
    const weighted_score = computeWeightedScore(final, bandConfig.weights);
    scored.push({
      ...final,
      role: c.role,
      weighted_score,
      fermi_estimate: c.fermi_estimate,
      risk_flags,
      devils_advocate,
    });
  }

  return scored;
}

function toIdeaRow(s: ScoredWithWeight): Record<string, unknown> {
  return {
    title: s.title,
    why: s.why,
    what: s.what,
    how: s.how,
    category: s.category,
    market_score: s.market_score,
    tech_score: s.tech_score,
    competition_score: s.competition_score,
    weighted_score: s.weighted_score,
    competitors: s.competitors,
    source_signal_ids: s.source_signal_ids,
    // role は DB 内の audit trail 専用 (どの drafter 役割が生んだアイデアかを後追跡するため)。
    // deliver には出さない。
    role: s.role,
    // Sprint B:
    //   fermi_estimate    = Markdown に「月 5 万円到達: ...」で表示 (render-markdown.ts)
    //   risk_flags        = Markdown に「⚠️ リスク: ...」で表示 (render-markdown.ts)
    //   devils_advocate   = DB 内の audit trail 専用。deliver には出さず、手動 SQL / 将来の振り返り用途
    fermi_estimate: s.fermi_estimate,
    risk_flags: s.risk_flags,
    devils_advocate: s.devils_advocate,
  };
}

async function main(): Promise<void> {
  const bandConfig = describeBandConfig();
  console.log(
    `[analyze] window=${WINDOW_HOURS}h, started=${new Date().toISOString()} ${bandConfig.logLine}`,
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

  // 需要シグナルサマリ計算用に source + metadata を id で引けるようにしておく。
  // SourceType の enum に入っていない値 (旧データ) はスキップする。
  const metadataById = new Map<
    string,
    { source: SourceType; metadata: Record<string, unknown> | null }
  >();
  for (const r of rows) {
    const src = SourceTypeSchema.safeParse(r.source);
    if (!src.success) continue;
    metadataById.set(r.id, { source: src.data, metadata: r.metadata });
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
  const drafted = await draftByThreeRoles(cluster, signals, metadataById);
  console.log(`[analyze] total_drafted=${drafted.length}`);
  if (drafted.length === 0) {
    await markProcessed(signals.map((s) => s.id));
    console.log('[analyze] no drafts, signals marked processed');
    return;
  }

  // 3) 役割間で title+category 一致する重複を dedup
  const candidates = dedupeCandidates(drafted);
  const removed = drafted.length - candidates.length;
  if (removed > 0) {
    console.log(`[analyze] after_dedup=${candidates.length} removed=${removed}`);
  }

  // 4) Top 10 を Tavily + Sonnet 3 軸スコアリング (帯依存 rubric)
  const scored = await scoreTopCandidates(candidates, bandConfig);
  console.log(`[analyze] sonnet_scored=${scored.length}`);

  // 5) 足切り: tech_score が TECH_SCORE_MIN 未満のアイデアは個人開発で MVP に辿り着けない
  //    可能性が高いので ideas への insert 対象から除外する (帯に関係なく共通)。
  //    結果 5 件を下回る日は実件数で deliver する (件数保証より品質保証を優先)。
  const passed = scored.filter((s) => s.tech_score >= TECH_SCORE_MIN);
  const filteredOut = scored.length - passed.length;
  if (filteredOut > 0) {
    console.log(
      `[analyze] tech_score_filter removed=${filteredOut} (tech_score < ${TECH_SCORE_MIN})`,
    );
  }

  // 6) weighted_score DESC で Top 5
  const finals = [...passed]
    .sort((a, b) => b.weighted_score - a.weighted_score)
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
