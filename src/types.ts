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

// ---- Haiku クラスタリング ----
// Haiku はシグナルを 3 種類のバンドル/候補に分類するだけで、アイデア文は書かない。
// 各バンドルは後段の Sonnet × 3 役割 (集約者 / 結合者 / 隙間発見者) に渡す。

// 集約者用: 同じ痛みを指す 3+ signals のクラスタ
export const AggregatorBundleSchema = z.object({
  theme: z.string().min(1), // クラスタの主題を短く (例: "Zennの記事管理で似たファイルが多すぎる")
  signal_ids: z.array(z.string().uuid()).min(3),
});
export type AggregatorBundle = z.infer<typeof AggregatorBundleSchema>;

// 結合者用: 痛み + 技術/情報 の組み合わせ候補。最低 2 signals (痛み 1 + 情報 1)
// pain_signal_ids (痛みを含むシグナル) と info_signal_ids (技術/情報を含むシグナル) に分離。
// 合計 signal 数が 2 未満の候補は Haiku 側で出力しないよう指示する。
export const CombinatorPairSchema = z.object({
  angle: z.string().min(1), // 掛け合わせの観点 (例: "新規OSS × 既存の面倒な作業")
  pain_signal_ids: z.array(z.string().uuid()).min(1),
  info_signal_ids: z.array(z.string().uuid()).min(1),
});
export type CombinatorPair = z.infer<typeof CombinatorPairSchema>;

// 隙間発見者用: 既存プロダクト告知 / 有料サービス言及 / 隣接ドメイン移植のネタ元。
// 1 signal からでも成立するケースが多い。
export const GapCandidateSchema = z.object({
  angle: z.enum(['launch_hn', 'show_hn', 'paid_service_mention', 'niche_transfer', 'other']),
  hint: z.string().min(1), // どの方向で隙間を狙うかの短文ヒント
  signal_ids: z.array(z.string().uuid()).min(1),
});
export type GapCandidate = z.infer<typeof GapCandidateSchema>;

export const HaikuClusterOutputSchema = z.object({
  aggregator_bundles: z.array(AggregatorBundleSchema),
  combinator_pairs: z.array(CombinatorPairSchema),
  gap_candidates: z.array(GapCandidateSchema),
});
export type HaikuClusterOutput = z.infer<typeof HaikuClusterOutputSchema>;

// ---- Sonnet × 3 役割のアイデア起草 ----
// 各役割は共通スキーマ (HaikuIdeaCandidate と互換) でアイデア候補を返す。
// role はどの役割が起草したかを analyze 側で観測ログに出すための注釈。

export const IdeaRoleSchema = z.enum(['aggregator', 'combinator', 'gap_finder']);
export type IdeaRole = z.infer<typeof IdeaRoleSchema>;

// アイデアは WHY / WHAT / HOW の 3 段構成で記述する:
//   why  = 誰のどんな痛みか (ターゲット像 + 状況 + 困りごと)
//   what = 何を作るか (プロダクト概要 + 差別化 + 収益モデル)
//   how  = どう実現するか (技術スタック + MVP 最小構成 + 実装難度 / 期間)
// レポートで「HOW が薄い = 実装イメージが無い」のフィルタに使えるため、
// 3 フィールドとも具体文を強制する (zod min(1))。
export const HaikuIdeaCandidateSchema = z.object({
  title: z.string().min(1),
  why: z.string().min(1),
  what: z.string().min(1),
  how: z.string().min(1),
  category: IdeaCategorySchema,
  raw_score: z.number().int().min(1).max(5),
  source_signal_ids: z.array(z.string().uuid()).min(1),
});
export type HaikuIdeaCandidate = z.infer<typeof HaikuIdeaCandidateSchema>;

export const RoleIdeaOutputSchema = z.object({
  candidates: z.array(HaikuIdeaCandidateSchema),
});
export type RoleIdeaOutput = z.infer<typeof RoleIdeaOutputSchema>;

// 3 役割の出力をマージした中間表現 (analyze 側で使う)
export interface RoleTaggedCandidate extends HaikuIdeaCandidate {
  role: IdeaRole;
}

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
  why: z.string().min(1),
  what: z.string().min(1),
  how: z.string().min(1),
  category: IdeaCategorySchema,
  market_score: z.number().int().min(1).max(5),
  tech_score: z.number().int().min(1).max(5),
  competition_score: z.number().int().min(1).max(5),
  competitors: z.array(CompetitorSchema),
  source_signal_ids: z.array(z.string().uuid()).min(1),
});
export type SonnetScoredIdea = z.infer<typeof SonnetScoredIdeaSchema>;
