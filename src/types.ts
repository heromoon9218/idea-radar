import { z } from 'zod';

export const SourceTypeSchema = z.enum([
  'hatena',
  'zenn',
  'hackernews',
]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

export const RawSignalInputSchema = z.object({
  source: SourceTypeSchema,
  external_id: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  content: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  posted_at: z.string().datetime({ offset: true }),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type RawSignalInput = z.infer<typeof RawSignalInputSchema>;

// ---- ideas / analyze パイプライン ----

export const IdeaCategorySchema = z.enum([
  'dev-tool',
  'productivity',
  'saas',
  'ai',
  'other',
]);
export type IdeaCategory = z.infer<typeof IdeaCategorySchema>;

// HN タイトルの慣用プリフィックス分類。
// Show/Launch/Ask HN は個人開発ネタの「金鉱」なので、Haiku 側で優先度を上げる用途に使う。
export const HnStoryTypeSchema = z.enum(['show', 'ask', 'launch', 'tell', 'normal']);
export type HnStoryType = z.infer<typeof HnStoryTypeSchema>;

// Haiku への入力 1 件ぶん (raw_signals から必要列だけ抜き出したもの)
export const HaikuSignalInputSchema = z.object({
  id: z.string().uuid(),
  source: SourceTypeSchema,
  title: z.string(),
  content: z.string().nullable(),
  url: z.string().url(),
  // HN のみ: タイトル先頭の Show/Ask/Launch/Tell HN 分類。
  // それ以外のソースでは undefined。
  hn_story_type: HnStoryTypeSchema.optional(),
});
export type HaikuSignalInput = z.infer<typeof HaikuSignalInputSchema>;

// Haiku が返すアイデア候補 (同じ痛みのシグナルは 1 件にマージ済み)
export const HaikuIdeaCandidateSchema = z.object({
  title: z.string().min(1),
  pain_summary: z.string().min(1),
  idea_description: z.string().min(1),
  category: IdeaCategorySchema,
  raw_score: z.number().int().min(1).max(5),
  source_signal_ids: z.array(z.string().uuid()).min(1),
});
export type HaikuIdeaCandidate = z.infer<typeof HaikuIdeaCandidateSchema>;

export const HaikuOutputSchema = z.object({
  candidates: z.array(HaikuIdeaCandidateSchema),
});
export type HaikuOutput = z.infer<typeof HaikuOutputSchema>;

// Tavily / Sonnet のあいだで受け渡す競合 1 件
export const CompetitorSchema = z.object({
  name: z.string().min(1),
  url: z.string().url().optional(),
  note: z.string().optional(),
});
export type Competitor = z.infer<typeof CompetitorSchema>;

// Sonnet が返すスコアリング済みアイデア
export const SonnetScoredIdeaSchema = z.object({
  title: z.string().min(1),
  pain_summary: z.string().min(1),
  idea_description: z.string().min(1),
  category: IdeaCategorySchema,
  market_score: z.number().int().min(1).max(5),
  tech_score: z.number().int().min(1).max(5),
  competition_score: z.number().int().min(1).max(5),
  competitors: z.array(CompetitorSchema),
  source_signal_ids: z.array(z.string().uuid()).min(1),
});
export type SonnetScoredIdea = z.infer<typeof SonnetScoredIdeaSchema>;
