// 日次バッチの分析パイプライン:
//   1. raw_signals (未処理 / 直近 24h) を取得
//   2. Haiku クラスタリング: aggregator_bundles (≥3) / combinator_pairs (≥2) / gap_candidates (≥1)
//   3. Sonnet × 3 役割並列: 集約者 / 結合者 / 隙間発見者 がそれぞれアイデアを起草
//      (各役割内は DRAFT_CONCURRENCY で同時実行数を制限、B-3 で fermi_estimate を必須化)
//   4. 合流 → 役割間で title+category 一致するアイデアを dedup
//   5. dedup 後の全候補を raw_score DESC でソート → 1 件ずつ:
//        a. Tavily 並列検索 (英語 / 日本語 / 機能語の最大 3 クエリ union) [B-4]
//        b. Sonnet 3 軸スコアリング (初回)
//        c. 赤旗スキャン (risk_auditor) + Devil's advocate 2-pass 再スコア を Promise.all [B-1/B-2]
//        d. 再スコアを採用、reasoning は devils_advocate jsonb へ保持
//   6. 足切り (3 条件 AND): market_score >= 3 / competition_score >= 3 /
//      risk_flags に category='distribution' && severity='high' が無いこと
//      → weighted_score DESC で Top 5 を ideas に insert
//      (技術難度の足切りは撤廃: 個人開発する意義があるアイデアは難度が高くても残す)
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
  COMPETITION_SCORE_MIN,
  MARKET_SCORE_MIN,
  type BandConfig,
} from './lib/goal-band.js';
import { searchParallel, type TavilySearchResult } from './lib/tavily.js';
import {
  HaikuSignalInputSchema,
  HnStoryTypeSchema,
  SourceTypeSchema,
  type DevilsAdvocatePersisted,
  type DistributionHypothesis,
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

// デフォルトの分析窓 (env 未指定時)。週次バッチ運用では env で override する。
const WINDOW_HOURS = 24;
// 週次バッチで chunk ごとに analyze.ts を起動するための env 変数。
// ANALYZE_DAYS_AGO_START / END は「今 (UTC) から N 日前」を整数で指定し、
// raw_signals.collected_at が [start, end) の範囲のものだけを対象にする。
// 例: 土曜 UTC 20:00 起動で「先週土日」を分析するなら START=7 / END=5。
//   - START=7 → now - 7d (= 先週日曜 UTC 20:00) より新しい
//   - END=5   → now - 5d (= 月曜 UTC 20:00) より古い
//   - 結果: 先週日 UTC 20:00 〜 月 UTC 20:00 の collected_at = 先週の土日収集分
// ANALYZE_DAYS_AGO_END=0 は「現在まで」を意味する。
// どちらかが未設定なら従来の WINDOW_HOURS=24 ベースで動く (smoke / 手動実行用の互換)。
const ANALYZE_DAYS_AGO_START_ENV = 'ANALYZE_DAYS_AGO_START';
const ANALYZE_DAYS_AGO_END_ENV = 'ANALYZE_DAYS_AGO_END';
// 現行 4 ソースの日次件数内訳 (SE 主要化 + 技術系圧縮後):
//   hatena (~38) + zenn (~30) + HN 非 normal (~75) + HN normal top 30 + stackexchange 15 site (~80-150)
//   = 定常 ~250-350 件。初回 ingest 時は SE の sort=month/hot 2 クエリ合計で 700-800 件まで伸びる想定。
// 上限を 1200 に置いているのは、この初回スパイクを取りこぼさず 1 日で処理し切るため
// (MAX_SIGNALS_PER_BATCH を超えた分は 24h window から外れて永久に未処理になる)。
// Haiku のコンテキストウィンドウは 200k+ で余裕があり、Sonnet drafter のコストは
// クラスタ数 (= AGGREGATOR_MAX_INPUTS + COMBINATOR_MAX_INPUTS + GAP_MAX_INPUTS の合計上限)
// で頭打ちになるため、signal 数増加がコストに線形比例せず、上限引き上げは安全。
const MAX_SIGNALS_PER_BATCH = 1200;
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

// scoreAllCandidates の candidate-level 並列度。
// 1 candidate あたり Sonnet 呼び出しは {score, risk_audit, devils_advocate} の 3 本
// (risk + devils は Promise.all で同時発火)。1 candidate 完了に ~40s。
// 値を 2 にしている根拠 (Sonnet 4.6 の TPM 8,000 output tokens/min 制限):
//   - 1 candidate の出力 tokens は score(800) + risk(700) + devils(800) ≈ 2,300
//   - 並列度 2 で同時 2 candidates 走行 → 2,300 × 2 ÷ 40s × 60s ≈ 6,900 tok/min ← 枠内
//   - 並列度 3 だと ~10,350 tok/min で 8f1f7a6 で踏んだのと同じ 429 を再発する
// PR #46 の Top N 撤廃で sonnet_input が 30→65+ に増え、逐次 (=1) では 45min
// workflow timeout を超える (実測: 2026-04-27 run で 36/65 件処理時点で timeout)。
// 2 並列で 65×40s/2 = ~22min となり drafter 15min と合わせて 37min で収まる。
const SCORE_CONCURRENCY = 2;

// 各 drafter 役割への入力上限。Haiku のクラスタリング結果がスパイクすると
// (実測: 2026-04-24 gap=72 / 2026-04-26 gap=59) DRAFT_CONCURRENCY=1 直列実行で
// gap_finder だけで 30min の workflow timeout を食い潰し analyze 全体が cancel される。
// 純粋に drafter フェーズの所要時間を timeout 内に収めるためのキャップで、エビデンス強度
// (= 紐づく signal の数) 降順でトリムするので最終アウトプット品質への影響は限定的。
// 値の根拠 (1 ドラフト ~30-40s, 30min timeout 前提):
//   - 通常時の各役割の出力数: aggregator 0-8 / combinator 4-11 / gap 6-30
//   - 上限を超えるのは月数回のスパイク (SE 主要化以降)
//   - 3 役割は Promise.all で並列実行されるので、所要時間のボトルネックは最長役割
//     (= max(15, 20, 25) = gap=25 件 × ~35s ≈ 14.5min)。30min timeout に対し十分なマージン
//   - timeout 自体を延ばさないのは deliver workflow が analyze から 30min 後に走る制約のため
const AGGREGATOR_MAX_INPUTS = 15;
const COMBINATOR_MAX_INPUTS = 20;
const GAP_MAX_INPUTS = 25;

// Sprint B-4: 1 candidate あたり最大クエリ数。
// dedup 後の全候補をスコアリングするため、Tavily 月間 req 数は概ね
// (候補数 ~30) × MAX_QUERIES_PER_CANDIDATE (3) × バッチ頻度に比例する。
// 週次バッチ移行後は ~30 × 3 × 4 ≈ 360 req/月で無料枠 1,000 内に収まる前提。
// 日次バッチ運用中は ~30 × 3 × 30 ≈ 2,700 req/月で月後半に 429 を踏むが、
// searchParallel が status='failed' を返し scoreIdea が description のみで継続する fail-soft 経路で吸収する
// (市場性スコアは保守的に振れるが pipeline は止まらない)。
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

interface ScoredWithWeight extends SonnetScoredIdea {
  role: IdeaRole;
  weighted_score: number;
  fermi_estimate: FermiEstimate;
  distribution_hypothesis: DistributionHypothesis;
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

interface AnalyzeWindow {
  /** 範囲の下限 (含む)。ISO 8601 文字列。 */
  since: string;
  /** 範囲の上限 (含まない)。ISO 8601 文字列。 null なら上限なし。 */
  until: string | null;
  /** 観測ログ用ラベル。 */
  label: string;
}

/**
 * env var ANALYZE_DAYS_AGO_START / END から分析対象の collected_at 範囲を組み立てる。
 * 両方未設定なら従来の WINDOW_HOURS ベース (直近 24h)。片方だけは設定不可 (整合性のため
 * START / END をペアで運用する前提)。
 *
 * 範囲は [now - START, now - END) (END=0 なら "now まで")。週次 chunk 構成例:
 *   - 先週土日:  START=7 / END=5
 *   - 月火:      START=5 / END=3
 *   - 水木金:    START=3 / END=0
 */
function resolveAnalyzeWindow(): AnalyzeWindow {
  const startRaw = process.env[ANALYZE_DAYS_AGO_START_ENV];
  const endRaw = process.env[ANALYZE_DAYS_AGO_END_ENV];
  const hasStart = startRaw !== undefined && startRaw !== '';
  const hasEnd = endRaw !== undefined && endRaw !== '';
  if (hasStart !== hasEnd) {
    throw new Error(
      `${ANALYZE_DAYS_AGO_START_ENV} と ${ANALYZE_DAYS_AGO_END_ENV} は両方セットするか両方未設定にしてください (片方だけは禁止)`,
    );
  }
  if (!hasStart) {
    const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();
    return { since, until: null, label: `${WINDOW_HOURS}h` };
  }
  // ここから両方設定済み。整数として解釈し START > END > 0 の制約を確認。
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0) {
    throw new Error(
      `${ANALYZE_DAYS_AGO_START_ENV} / ${ANALYZE_DAYS_AGO_END_ENV} は 0 以上の整数で指定してください (start=${startRaw}, end=${endRaw})`,
    );
  }
  if (start <= end) {
    throw new Error(
      `${ANALYZE_DAYS_AGO_START_ENV} は ${ANALYZE_DAYS_AGO_END_ENV} より大きくする必要があります (start=${start}, end=${end})`,
    );
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const since = new Date(now - start * dayMs).toISOString();
  const until = end === 0 ? null : new Date(now - end * dayMs).toISOString();
  return { since, until, label: `days_ago=${start}..${end}` };
}

async function fetchUnprocessedSignals(window: AnalyzeWindow): Promise<SignalRow[]> {
  let q = supabase
    .from('raw_signals')
    .select('id, source, title, content, url, metadata')
    .eq('processed', false)
    .gte('collected_at', window.since);
  if (window.until !== null) {
    q = q.lt('collected_at', window.until);
  }
  const { data, error } = await q
    .order('collected_at', { ascending: false })
    .limit(MAX_SIGNALS_PER_BATCH);
  if (error) throw error;
  return (data ?? []) as SignalRow[];
}

// SignalRow → Haiku 入力形式 (zod でバリデートしてから配列化)。
// HN の metadata.story_type は Haiku プロンプトで参照させるので hn_story_type に昇格。
// Stack Exchange の metadata.se_site も同様に se_site に昇格 (サイトごとに痛みの領域が異なるため)。
// 異常データはログに出してスキップ。
//
// 2026-04-29 拡張:
//  - HN の metadata.top_comments (show/ask/launch HN のトップ 5 コメント) があれば
//    content と結合して Haiku に渡す (痛みクラスタリングの主要材料)。
//  - metadata.heavy_domain (重いドメイン早期 filter) は別途 toHaikuInputs 後に
//    Haiku プロンプト経由で扱うので、ここでは何もしない。
function toHaikuInputs(rows: SignalRow[]): HaikuSignalInput[] {
  const out: HaikuSignalInput[] = [];
  for (const r of rows) {
    let mergedContent = r.content;
    const enriched: Record<string, unknown> = {
      id: r.id,
      source: r.source,
      title: r.title,
      url: r.url,
    };
    if (r.source === 'hackernews' && r.metadata) {
      const parsed = HnStoryTypeSchema.safeParse(r.metadata.story_type);
      if (parsed.success) enriched.hn_story_type = parsed.data;
      // top_comments を content に追記。Haiku は title + content のみを見るので、
      // ここで結合しないとコメント情報が捨てられる。
      const tc = r.metadata.top_comments;
      if (
        Array.isArray(tc) &&
        tc.length > 0 &&
        tc.every((c) => typeof c === 'string' && c.length > 0)
      ) {
        const block = tc
          .map((c, i) => `[Comment ${i + 1}] ${c as string}`)
          .join('\n');
        const base = mergedContent ?? '';
        mergedContent =
          base.length > 0
            ? `${base}\n\n--- HN Top Comments ---\n${block}`
            : `--- HN Top Comments ---\n${block}`;
      }
    }
    if (r.source === 'stackexchange' && r.metadata) {
      const site = r.metadata.se_site;
      if (typeof site === 'string' && site.length > 0) enriched.se_site = site;
    }
    // ソース横断の metadata.heavy_domain / metadata.payment_intent を Haiku 入力に lift。
    if (r.metadata) {
      if (r.metadata.heavy_domain === true) enriched.heavy_domain = true;
      if (r.metadata.payment_intent === true) enriched.payment_intent = true;
    }
    enriched.content = mergedContent;
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

// 2026-04-29: empty フォールバック用クエリ。1 回目検索で 0 件だった場合に 1 本だけ追加発行する。
// 元の 3 クエリは title 中心 (プロダクト名 / 機能名) なので、empty のときは
// 「痛みベースのクエリ」に視点を変える: why から名詞句 + alternative を組む。
// failed (= 認証 / ネットワークエラー) の時は呼ばない (empty とは原因が違うため)。
function buildFallbackQuery(c: RoleTaggedCandidate): string | null {
  const whyHead = c.why.slice(0, 80).replace(/[。\.].*$/, '').trim();
  if (whyHead.length === 0) return null;
  const cat = CATEGORY_EN[c.category];
  // 「痛みフレーズ」 + alternative + カテゴリ。Tavily は自然文クエリを処理するので構文整形は不要。
  return `${whyHead} ${cat} alternative tool`.trim();
}

async function scoreAllCandidates(
  candidates: RoleTaggedCandidate[],
  bandConfig: BandConfig,
): Promise<ScoredWithWeight[]> {
  // raw_score DESC で並べるのは「Tavily 429 を踏んで途中で fail-soft に落ちたとき
  // でも上位候補を先に通電させて評価精度を保つ」ための保険。Top N で切らず全件処理する。
  const ordered = [...candidates].sort((a, b) => b.raw_score - a.raw_score);

  const roleCount = ordered.reduce<Record<IdeaRole, number>>(
    (acc, c) => {
      acc[c.role] = (acc[c.role] ?? 0) + 1;
      return acc;
    },
    { aggregator: 0, combinator: 0, gap_finder: 0 },
  );
  console.log(
    `[analyze] sonnet_input=${ordered.length} by_role aggregator=${roleCount.aggregator} combinator=${roleCount.combinator} gap_finder=${roleCount.gap_finder}`,
  );

  // 1 candidate あたりの scoring 処理。Tavily 競合検索 → Sonnet 3 軸スコア
  // → risk_audit + devils_advocate 並列の順で Sonnet を計 3 回叩く。
  // mapWithLimit で SCORE_CONCURRENCY 並列に走る前提で、グローバルな
  // SEARCH_MIN_INTERVAL_MS guard は撤去 (並列度 2 × 1 candidate あたり 3 クエリ
  // = 同時 ~6 Tavily req のバースト。無料枠 1,000/月でも per-second 制限は
  // 公表されておらず、searchParallel 側の 429 fail-soft で吸収する)。
  const scoreOne = async (c: RoleTaggedCandidate): Promise<ScoredWithWeight | null> => {
    // Sprint B-4: 2-3 本並列検索で日本語競合も拾う。
    // 2026-04-29: empty (= 全クエリ成功 0 件) のとき why から組み立てた痛みベースの fallback を 1 本追加発行。
    // これは「title が specific すぎて競合に当たらないが、別の用語で類似サービスがある」ケースを救う。
    // failed (= ネットワーク / 認証エラー) のときはリトライしない (原因が変わらず credit を浪費するため)。
    const queries = buildTavilyQueries(c);
    let hits: TavilySearchResult[] = [];
    let status: TavilyStatus = 'ok';
    try {
      let parallel = await searchParallel(queries, 5, 8);
      console.log(
        `[tavily] queries=${parallel.queriesAttempted} failed=${parallel.queriesFailed} hits=${parallel.results.length} status=${parallel.status} title="${c.title.slice(0, 40)}"`,
      );
      if (parallel.status === 'empty') {
        const fallback = buildFallbackQuery(c);
        if (fallback) {
          console.log(
            `[tavily] empty, retrying fallback="${fallback.slice(0, 60)}" title="${c.title.slice(0, 40)}"`,
          );
          const retry = await searchParallel([fallback], 5, 8);
          if (retry.status === 'ok' && retry.results.length > 0) {
            parallel = {
              results: retry.results,
              status: 'ok',
              queriesAttempted: parallel.queriesAttempted + retry.queriesAttempted,
              queriesFailed: parallel.queriesFailed + retry.queriesFailed,
            };
            console.log(
              `[tavily] fallback recovered ${retry.results.length} hits title="${c.title.slice(0, 40)}"`,
            );
          }
        }
      }
      hits = parallel.results;
      status = parallel.status;
    } catch (err) {
      status = 'failed';
      console.warn(
        `[tavily] parallel unexpected error for "${c.title}" status=failed:`,
        err instanceof Error ? err.message : err,
      );
    }

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
      return null;
    }

    // Sprint B-1 / B-2: リスク監査 + Devil's advocate 2-pass を並列実行。
    // いずれも初回スコアに依存するが、互いには独立なので Promise.all で同時発火。
    // どちらかが失敗しても他方は生かす (allSettled)。
    // risk_auditor には distribution_hypothesis も渡す (流通カテゴリの判定材料)。
    const [riskSettled, devilSettled] = await Promise.allSettled([
      auditRisks({ candidate: initial, distribution: c.distribution_hypothesis }),
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
      upgrade_reasons: [],
      verdict: 'devils_advocate 呼び出しが失敗 / スキップされたため初回スコアをそのまま採用',
      initial_scores: {
        market: initial.market_score,
        tech: initial.tech_score,
        competition: initial.competition_score,
      },
    };
    if (devilSettled.status === 'fulfilled') {
      const d = devilSettled.value;
      // 両側 0 件ガード: schema は両方 .max(5) のみで .min(0) 相当なので、
      // model がドリフトして両側 [] を返すと「論拠なしで再採点」が成立してしまう。
      // 両側空のときは初回スコア維持に倒し、verdict にその旨を残す。
      const bothEmpty =
        d.rejection_reasons.length === 0 && d.upgrade_reasons.length === 0;
      if (bothEmpty) {
        console.warn(
          `[analyze] devils_advocate returned both reasons empty for "${c.title.slice(0, 40)}" — initial scores 維持`,
        );
        devils_advocate = {
          rejection_reasons: [],
          upgrade_reasons: [],
          verdict: '両側理由が空のため再採点を破棄し初回スコアを維持',
          initial_scores: {
            market: initial.market_score,
            tech: initial.tech_score,
            competition: initial.competition_score,
          },
        };
      } else {
        finalMarket = d.reconsidered_market_score;
        finalTech = d.reconsidered_tech_score;
        finalComp = d.reconsidered_competition_score;
        devils_advocate = {
          rejection_reasons: d.rejection_reasons,
          upgrade_reasons: d.upgrade_reasons,
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
          `[analyze] devils_advocate title="${c.title.slice(0, 40)}" reject=${d.rejection_reasons.length} upgrade=${d.upgrade_reasons.length} delta_sum=${delta >= 0 ? '+' : ''}${delta}`,
        );
      }
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
    // Sprint C-1: weighted_score に sns_dependency=high のペナルティを乗せる。
    // distribution_hypothesis は drafter で必須化されているので必ず存在する。
    const weighted_score = computeWeightedScore(
      final,
      bandConfig.weights,
      c.distribution_hypothesis,
    );
    return {
      ...final,
      role: c.role,
      weighted_score,
      fermi_estimate: c.fermi_estimate,
      distribution_hypothesis: c.distribution_hypothesis,
      risk_flags,
      devils_advocate,
    };
  };

  const settled = await mapWithLimit(ordered, SCORE_CONCURRENCY, scoreOne);
  const scored: ScoredWithWeight[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value !== null) {
      scored.push(r.value);
    } else if (r.status === 'rejected') {
      console.warn(
        '[analyze] scoreOne unexpected rejection:',
        r.reason instanceof Error ? r.reason.message : r.reason,
      );
    }
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
    // Sprint C-1:
    //   distribution_hypothesis = Markdown に「**流通仮説**: ...」で表示 (render-markdown.ts)
    //                              + sns_dependency=high はここまでで weighted_score に -1.0 のペナルティ反映済み
    fermi_estimate: s.fermi_estimate,
    distribution_hypothesis: s.distribution_hypothesis,
    risk_flags: s.risk_flags,
    devils_advocate: s.devils_advocate,
  };
}

// Haiku 出力の各バンドル種別を上限で切り詰める。トリム時はログを残して観測可能にする。
// Haiku の出力順はスキーマレベルでは保証されないので、エビデンス強度
// (= 紐づく signal の数) の降順でソートしてから先頭 max 件を採用する。
// combinator は pain と info を合算した総 signal 数で評価する。
function capDrafterInputs(
  cluster: Awaited<ReturnType<typeof clusterSignals>>,
): Awaited<ReturnType<typeof clusterSignals>> {
  const capByEvidence = <T>(
    items: T[],
    max: number,
    label: string,
    evidenceOf: (item: T) => number,
  ): T[] => {
    if (items.length <= max) return items;
    const sorted = [...items].sort((a, b) => evidenceOf(b) - evidenceOf(a));
    console.log(`[analyze] ${label} trimmed ${items.length}→${max} (cap to fit timeout)`);
    return sorted.slice(0, max);
  };
  return {
    aggregator_bundles: capByEvidence(
      cluster.aggregator_bundles,
      AGGREGATOR_MAX_INPUTS,
      'aggregator_bundles',
      (b) => b.signal_ids.length,
    ),
    combinator_pairs: capByEvidence(
      cluster.combinator_pairs,
      COMBINATOR_MAX_INPUTS,
      'combinator_pairs',
      (p) => p.pain_signal_ids.length + p.info_signal_ids.length,
    ),
    gap_candidates: capByEvidence(
      cluster.gap_candidates,
      GAP_MAX_INPUTS,
      'gap_candidates',
      (g) => g.signal_ids.length,
    ),
  };
}

async function main(): Promise<void> {
  const bandConfig = describeBandConfig();
  const window = resolveAnalyzeWindow();
  console.log(
    `[analyze] window=${window.label} since=${window.since} until=${window.until ?? 'now'}, started=${new Date().toISOString()} ${bandConfig.logLine}`,
  );

  const rows = await fetchUnprocessedSignals(window);
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
  // スパイク日 (gap が 50+ 出る等) に drafter フェーズが timeout を食い潰さないよう、
  // 各役割への入力数を上限でトリミングする (signal_ids 数 = エビデンス強度の降順で先頭 N 件)。
  const cappedCluster = capDrafterInputs(cluster);
  const totalClusterInputs =
    cappedCluster.aggregator_bundles.length +
    cappedCluster.combinator_pairs.length +
    cappedCluster.gap_candidates.length;
  if (totalClusterInputs === 0) {
    // クラスタリング結果 0 件でもこのバッチのシグナルは処理済みとみなす
    await markProcessed(signals.map((s) => s.id));
    console.log('[analyze] no clusters, signals marked processed');
    return;
  }

  // 2) Sonnet × 3 役割並列でアイデア起草
  const drafted = await draftByThreeRoles(cappedCluster, signals, metadataById);
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

  // 4) 全候補を Tavily + Sonnet 3 軸スコアリング (帯依存 rubric)
  const scored = await scoreAllCandidates(candidates, bandConfig);
  console.log(`[analyze] sonnet_scored=${scored.length}`);

  // 5) 足切り (3 条件 AND):
  //      a. market_score  >= MARKET_SCORE_MIN  (市場性が確保できないアイデアは月 ¥50k に届かない)
  //      b. competition_score >= COMPETITION_SCORE_MIN (競合に埋もれるアイデアは個人で勝てない)
  //      c. risk_flags に category='distribution' && severity='high' が含まれないこと
  //         (営業組織必須・大規模広告必須・代理店ネットワーク必須・SNS バズ前提 = 個人開発の流通域を超える)
  //    技術難度の足切りは撤廃: 「個人開発する意義」があるアイデアは多少難度が高くても残す方針。
  //    結果 5 件を下回る日は実件数で deliver する (件数保証より品質保証を優先)。
  // 統計用: 1 アイデアにつき「最初に当たった足切り理由」だけ 1 回カウントする
  // (market → competition → distribution の優先順位で mutually exclusive)。
  // 別 filter を 3 回回すと複数条件で落ちたアイデアが重複カウントされ、合算が
  // removed と一致しないログが出てしまうので、本ループ内で同時に集計する。
  let byMarket = 0;
  let byComp = 0;
  let byDist = 0;
  const passed = scored.filter((s) => {
    if (s.market_score < MARKET_SCORE_MIN) {
      byMarket++;
      return false;
    }
    if (s.competition_score < COMPETITION_SCORE_MIN) {
      byComp++;
      return false;
    }
    const distHigh = s.risk_flags.some(
      (f) => f.category === 'distribution' && f.severity === 'high',
    );
    if (distHigh) {
      byDist++;
      return false;
    }
    return true;
  });
  const filteredOut = scored.length - passed.length;
  if (filteredOut > 0) {
    console.log(
      `[analyze] gate_filter removed=${filteredOut} (market<${MARKET_SCORE_MIN}=${byMarket} / competition<${COMPETITION_SCORE_MIN}=${byComp} / distribution_high=${byDist})`,
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
