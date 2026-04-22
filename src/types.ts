import { z } from 'zod';

export const SourceTypeSchema = z.enum([
  'hatena',
  'zenn',
  'hackernews',
  // 軽量ドメインの痛みを拾うための非技術系ソース:
  //   note   = 日本語のクリエイター / 副業 / 投資 / ブロガー 系ハッシュタグ
  //   reddit = 英語の SMB / サイドハッスル / ハンドメイド EC / 自己管理 系 subreddit
  'note',
  'reddit',
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

// Sprint B-3: フェルミ推定。個人開発で TARGET_MRR に到達する道筋を必須化する。
//   unit_price   = 想定単価 (円、正の整数)
//   unit_type    = 'monthly' | 'one_time' | 'per_use' — 課金形態
//   mrr_formula  = 「買い切り 3,000 円 × 月 17 本 = 51,000 円」のような自然文の算式。
//                  Markdown への可読出力・人間レビューに使う。
export const FermiUnitTypeSchema = z.enum(['monthly', 'one_time', 'per_use']);
export type FermiUnitType = z.infer<typeof FermiUnitTypeSchema>;

export const FermiEstimateSchema = z.object({
  unit_price: z.number().int().min(1),
  unit_type: FermiUnitTypeSchema,
  mrr_formula: z.string().min(1),
});
export type FermiEstimate = z.infer<typeof FermiEstimateSchema>;

// アイデアは WHY / WHAT / HOW の 3 段構成で記述する:
//   why  = 誰のどんな痛みか (ターゲット像 + 状況 + 困りごと)
//   what = 何を作るか (プロダクト概要 + 差別化 + 収益モデル)
//   how  = どう実現するか (技術スタック + MVP 最小構成 + 実装難度 / 期間)
// レポートで「HOW が薄い = 実装イメージが無い」のフィルタに使えるため、
// 3 フィールドとも具体文を強制する (zod min(1))。
// Sprint B-3: fermi_estimate を必須化 (drafter 3 役割は推定不可の場合アイデア自体を除外する)。
export const HaikuIdeaCandidateSchema = z.object({
  title: z.string().min(1),
  why: z.string().min(1),
  what: z.string().min(1),
  how: z.string().min(1),
  category: IdeaCategorySchema,
  raw_score: z.number().int().min(1).max(5),
  fermi_estimate: FermiEstimateSchema,
  source_signal_ids: z.array(z.string().uuid()).min(1),
});
export type HaikuIdeaCandidate = z.infer<typeof HaikuIdeaCandidateSchema>;

// drafter が LLM 出力を受ける際の緩スキーマ。
// HaikuIdeaCandidateSchema との差分は fermi_estimate を optional にしていること。
// 狙い: LLM が個別アイデアで fermi_estimate を付け忘れた場合に、バンドル全体が zod parse 失敗で
//       ロスするのを避ける。drafter 側で欠落アイデアだけ warn + filter out し、健全な候補は通す。
// 下流 (analyze.ts) では fermi_estimate 必須の HaikuIdeaCandidate を期待するので、
// drafter が戻り値を返す前に filter すること (analyzers/draft-filter.ts 参照)。
export const DraftCandidateSchema = HaikuIdeaCandidateSchema.extend({
  fermi_estimate: FermiEstimateSchema.optional(),
});
export type DraftCandidate = z.infer<typeof DraftCandidateSchema>;

export const DraftOutputSchema = z.object({
  candidates: z.array(DraftCandidateSchema),
});
export type DraftOutput = z.infer<typeof DraftOutputSchema>;

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

// Sonnet が返すスコアリング済みアイデア。
// fermi_estimate は scoreIdea 内の LLM には触らせず、candidate 側の値を上書き保持する
// (source_signal_ids と同じ扱い)。スキーマには含めない。
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

// ---- Sprint B-1: Devil's advocate 2-pass ----
// 初回スコア後に Sonnet に「却下すべき 3 つの理由」を挙げさせ、その上で 3 軸を再スコア。
// reconsidered_* を最終値として insert し、ideas.devils_advocate に reasoning のみ残す。
export const DevilsAdvocateOutputSchema = z.object({
  rejection_reasons: z.array(z.string().min(1)).min(1).max(5),
  reconsidered_market_score: z.number().int().min(1).max(5),
  reconsidered_tech_score: z.number().int().min(1).max(5),
  reconsidered_competition_score: z.number().int().min(1).max(5),
  verdict: z.string().min(1),
});
export type DevilsAdvocateOutput = z.infer<typeof DevilsAdvocateOutputSchema>;

// DB 保持用の ideas.devils_advocate jsonb 構造 (初回スコアと却下理由を audit trail として残す)。
// 運用方針: この jsonb は DB 内のレビュー用途 (手動 SQL / 将来の振り返り UI) 専用で、
// deliver (render-markdown) では表示しない。Markdown に出るのは rescore 後の 3 軸スコアのみ。
export const DevilsAdvocatePersistedSchema = z.object({
  rejection_reasons: z.array(z.string()),
  verdict: z.string(),
  initial_scores: z.object({
    market: z.number().int(),
    tech: z.number().int(),
    competition: z.number().int(),
  }),
});
export type DevilsAdvocatePersisted = z.infer<typeof DevilsAdvocatePersistedSchema>;

// ---- Sprint B-2: 赤旗スキャン (risk-auditor) ----
// 法規制 (薬機法・金商法・資金決済法・景表法) / API 規約違反 / 倫理リスクを
// 1 アイデアあたり 0-5 件スキャン。赤旗ありでも除外はせず Markdown に警告表示。
export const RiskSeveritySchema = z.enum(['low', 'mid', 'high']);
export type RiskSeverity = z.infer<typeof RiskSeveritySchema>;

export const RiskFlagSchema = z.object({
  kind: z.string().min(1), // ラベル (例: "薬機法 (SaMD 該当性)", "Google Maps API 商用規約", "医療ドメインの倫理リスク")
  severity: RiskSeveritySchema,
  reason: z.string().min(1), // 1-2 文の根拠
});
export type RiskFlag = z.infer<typeof RiskFlagSchema>;

export const RiskAuditOutputSchema = z.object({
  risk_flags: z.array(RiskFlagSchema).max(5),
});
export type RiskAuditOutput = z.infer<typeof RiskAuditOutputSchema>;
