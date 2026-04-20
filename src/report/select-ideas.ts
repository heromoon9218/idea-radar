// 未配信 ideas と紐づく raw_signals (URL) を取得する。
// ideas.delivered_at IS NULL + 直近 24h + total_score DESC で Top 5 まで。

import { z } from 'zod';
import { supabase } from '../db/supabase.js';
import { CompetitorSchema, IdeaCategorySchema, SourceTypeSchema, type Competitor } from '../types.js';

const WINDOW_HOURS = 24;
const TOP_N = 5;
// reports 側で直近何日の idea_ids を「配信済み」として扱うか。
// markIdeasDelivered が失敗して delivered_at が NULL のまま残ったケースで、
// 翌日の fetch で同じ idea を再度拾って二重配信するのを防ぐためのガード。
const REPORTED_LOOKBACK_DAYS = 2;

// competitors は jsonb なので parse は後段 (parseCompetitors) に任せる。
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
  competitors: z.unknown(),
  source_signal_ids: z.array(z.string().uuid()),
  created_at: z.string(),
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
  competitors: Competitor[];
  source_signal_ids: string[];
  created_at: string;
  sources: SourceLink[];
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
      'id, title, why, what, how, category, market_score, tech_score, competition_score, total_score, competitors, source_signal_ids, created_at',
    )
    .is('delivered_at', null)
    .gte('created_at', since)
    .order('total_score', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(TOP_N * 2); // reports ガード除外後に TOP_N 確保するため多めに取る

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
      competitors,
      source_signal_ids: idea.source_signal_ids,
      created_at: idea.created_at,
      sources,
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
