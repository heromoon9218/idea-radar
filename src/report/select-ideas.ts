// 未配信 ideas と紐づく raw_signals (URL) を取得する。
// ideas.delivered_at IS NULL + 直近 8 日 (週次バッチ運用 + リカバリ余裕) + weighted_score DESC で Top 5 まで。

import { z } from 'zod';
import { supabase } from '../db/supabase.js';
import {
  CompetitorSchema,
  DistributionHypothesisSchema,
  FermiEstimateSchema,
  IdeaCategorySchema,
  IdeaRoleSchema,
  RiskFlagSchema,
  SourceTypeSchema,
  type Competitor,
  type DistributionHypothesis,
  type FermiEstimate,
  type IdeaRole,
  type RiskFlag,
} from '../types.js';

// 週次バッチで chunk 3 つ (Sat-Sun / Mon-Tue / Wed-Fri) が
// 過去 7 日分の signals を分析して ideas を insert するので 168h を基準に取る。
// ただし「ある週の deliver が失敗 → 翌週リカバリ」の境界ケースで、weekend chunk が
// 生成した ideas (Sat 03:30 頃 insert) が次週の Sat 08:00 deliver 時点で 7d 4.5h ≈ 172.5h
// 経過してしまい 168h 窓外に脱落する。これを救うため 192h (= 8 日) を採用。
// raw_signals の retention (30 日) には十分収まる。
const WINDOW_HOURS = 24 * 8;
const TOP_N = 5;
// reports 側で直近何日の idea_ids を「配信済み」として扱うか。
// markIdeasDelivered が失敗して delivered_at が NULL のまま残ったケースで、
// 次回の fetch で同じ idea を再度拾って二重配信するのを防ぐためのガード。
// 週次運用なので前回配信から最低 7 日経過する。安全マージンを 1 週間取って 14 日。
const REPORTED_LOOKBACK_DAYS = 14;

// competitors / fermi_estimate / risk_flags / distribution_hypothesis は jsonb。
// parse は後段 (parseXxx) に任せる。
// weighted_score は Sprint A-3 で追加された numeric(4,2) 列。
// Supabase クライアントは numeric を string で返すため z.coerce.number() で数値化する。
// Sprint B で追加された fermi_estimate / risk_flags は nullable (旧行は NULL のまま残るため)。
// Sprint C-1 で追加された distribution_hypothesis も同じく nullable。
const IdeaRowSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  why: z.string(),
  what: z.string(),
  how: z.string(),
  category: IdeaCategorySchema,
  market_score: z.number().int(),
  tech_score: z.number().int(),
  competition_score: z.number().int(),
  total_score: z.number().int(),
  weighted_score: z.coerce.number(),
  competitors: z.unknown(),
  source_signal_ids: z.array(z.string().uuid()),
  created_at: z.string(),
  fermi_estimate: z.unknown().nullable().optional(),
  risk_flags: z.unknown().nullable().optional(),
  distribution_hypothesis: z.unknown().nullable().optional(),
  // ideas.role は 20260511 マイグレーションで追加された audit trail。
  // それ以前にバックフィルされた行は NULL のまま残る (retro で埋められない) ので nullable。
  role: IdeaRoleSchema.nullable().optional(),
});

export type IdeaRow = z.infer<typeof IdeaRowSchema>;

export interface SourceLink {
  signal_id: string;
  source: z.infer<typeof SourceTypeSchema>;
  title: string;
  url: string;
}

export interface IdeaWithSources {
  id: string;
  title: string;
  why: string;
  what: string;
  how: string;
  category: z.infer<typeof IdeaCategorySchema>;
  market_score: number;
  tech_score: number;
  competition_score: number;
  total_score: number;
  weighted_score: number;
  competitors: Competitor[];
  source_signal_ids: string[];
  created_at: string;
  sources: SourceLink[];
  // Sprint B で導入。旧行は未設定なので null 可。
  fermi_estimate: FermiEstimate | null;
  risk_flags: RiskFlag[];
  // Sprint C-1 で導入。旧行は未設定なので null 可。
  distribution_hypothesis: DistributionHypothesis | null;
  // どの drafter 役割が起草したかの audit trail。
  // 20260511 のマイグレーション以前にバックフィルされた行は NULL のまま残る。
  role: IdeaRole | null;
}

const SignalRowSchema = z.object({
  id: z.string().uuid(),
  source: SourceTypeSchema,
  title: z.string(),
  url: z.string().url(),
});

export async function fetchUndeliveredTopIdeas(): Promise<IdeaRow[]> {
  const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('ideas')
    .select(
      'id, title, why, what, how, category, market_score, tech_score, competition_score, total_score, weighted_score, competitors, source_signal_ids, created_at, fermi_estimate, risk_flags, distribution_hypothesis, role',
    )
    .is('delivered_at', null)
    .gte('created_at', since)
    // weighted_score は Sprint A-3 で追加された帯別重み付きスコア。既存の total_score より
    // 個人開発ゴール (TARGET_MRR) に整合した順序で Top を選べる。
    .order('weighted_score', { ascending: false })
    .order('created_at', { ascending: false })
    // 週次バッチでは 3 chunks × INSERT_TOP_N=5 = 最大 15 ideas/週 が生成される。
    // reports ガード除外後でも TOP_N (=5) を確保できるよう余裕を持って 4 倍取る。
    .limit(TOP_N * 4);

  if (error) throw error;

  const rows: IdeaRow[] = [];
  for (const raw of data ?? []) {
    const parsed = IdeaRowSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(`[deliver] drop invalid idea row: ${parsed.error.message}`);
      continue;
    }
    rows.push(parsed.data);
  }

  // delivered_at が NULL でも、reports に idea_id が記録済みなら配信済み扱いにする
  // (markIdeasDelivered 失敗時の再配信防止 = 二重配信ガード)
  const reported = await fetchRecentlyReportedIdeaIds();
  const filtered = rows.filter((r) => !reported.has(r.id));
  if (filtered.length !== rows.length) {
    console.log(
      `[deliver] excluded=${rows.length - filtered.length} ideas already in reports`,
    );
  }

  return filtered.slice(0, TOP_N);
}

async function fetchRecentlyReportedIdeaIds(): Promise<Set<string>> {
  const sinceDate = new Date(Date.now() - REPORTED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const sinceDateStr = sinceDate.toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('reports')
    .select('idea_ids')
    .gte('date', sinceDateStr);
  if (error) throw error;

  const ids = new Set<string>();
  for (const row of data ?? []) {
    const arr = (row as { idea_ids?: string[] }).idea_ids;
    if (!Array.isArray(arr)) continue;
    for (const id of arr) ids.add(id);
  }
  return ids;
}

export async function attachSourceLinks(ideas: IdeaRow[]): Promise<IdeaWithSources[]> {
  const allSignalIds = [...new Set(ideas.flatMap((i) => i.source_signal_ids))];
  const byId = new Map<string, SourceLink>();

  if (allSignalIds.length > 0) {
    const { data, error } = await supabase
      .from('raw_signals')
      .select('id, source, title, url')
      .in('id', allSignalIds);
    if (error) throw error;

    for (const raw of data ?? []) {
      const parsed = SignalRowSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn(`[deliver] drop invalid raw_signals row: ${parsed.error.message}`);
        continue;
      }
      byId.set(parsed.data.id, {
        signal_id: parsed.data.id,
        source: parsed.data.source,
        title: parsed.data.title,
        url: parsed.data.url,
      });
    }
  }

  return ideas.map((idea) => {
    const competitors = parseCompetitors(idea.competitors);
    const sources = idea.source_signal_ids
      .map((sid) => byId.get(sid))
      .filter((v): v is SourceLink => Boolean(v));

    return {
      id: idea.id,
      title: idea.title,
      why: idea.why,
      what: idea.what,
      how: idea.how,
      category: idea.category,
      market_score: idea.market_score,
      tech_score: idea.tech_score,
      competition_score: idea.competition_score,
      total_score: idea.total_score,
      weighted_score: idea.weighted_score,
      competitors,
      source_signal_ids: idea.source_signal_ids,
      created_at: idea.created_at,
      sources,
      fermi_estimate: parseFermi(idea.fermi_estimate),
      risk_flags: parseRiskFlags(idea.risk_flags),
      distribution_hypothesis: parseDistributionHypothesis(idea.distribution_hypothesis),
      role: idea.role ?? null,
    };
  });
}

// jsonb は既に S2 側で CompetitorSchema 準拠にしてあるが、
// 壊れていたら空配列扱いで続行する (メール配信を止めない)。
function parseCompetitors(raw: unknown): Competitor[] {
  const parsed = z.array(CompetitorSchema).safeParse(raw);
  if (parsed.success) return parsed.data;
  console.warn('[deliver] invalid competitors jsonb, falling back to []:', parsed.error.message);
  return [];
}

// Sprint B: 旧 idea 行は NULL なので null 可で parse。
// 壊れていたら null 扱いで続行 (Markdown で無視)。
function parseFermi(raw: unknown): FermiEstimate | null {
  if (raw === null || raw === undefined) return null;
  const parsed = FermiEstimateSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.warn('[deliver] invalid fermi_estimate jsonb, dropping:', parsed.error.message);
  return null;
}

function parseRiskFlags(raw: unknown): RiskFlag[] {
  if (raw === null || raw === undefined) return [];
  const parsed = z.array(RiskFlagSchema).safeParse(raw);
  if (parsed.success) return parsed.data;
  console.warn('[deliver] invalid risk_flags jsonb, falling back to []:', parsed.error.message);
  return [];
}

// Sprint C-1: 旧 idea 行は NULL なので null 可で parse。
// 壊れていたら null 扱いで続行 (Markdown でセクション省略)。
function parseDistributionHypothesis(raw: unknown): DistributionHypothesis | null {
  if (raw === null || raw === undefined) return null;
  const parsed = DistributionHypothesisSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.warn(
    '[deliver] invalid distribution_hypothesis jsonb, dropping:',
    parsed.error.message,
  );
  return null;
}
