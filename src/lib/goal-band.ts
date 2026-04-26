// 個人開発の月収ゴール (TARGET_MRR) に基づいて、スコアリング rubric と
// weighted_score の重みを切り替える。analyze.ts / smoke.ts で共有。
//
// 帯の設計方針 (Sprint A-3):
//   ≤ 20,000 円         niche-deep     : コアユーザーへの深掘り。競合厚みは関係ない
//   20,001〜200,000 円  growth-channel : 持続性・流通設計・支払文化が効き始める境目
//   > 200,000 円        moat           : 参入障壁 (データ / ネットワーク効果 / 規制)

import type { DistributionHypothesis, SonnetScoredIdea } from '../types.js';

// 月収ゴール (円)。個人開発者 1 人の目標として growth-channel 帯中央に置く。
// 帯を切り替えたい場合はこの定数を書き換える (環境変数化しない方針)。
export const TARGET_MRR = 50000;

export type GoalBand = 'niche-deep' | 'growth-channel' | 'moat';

export interface ScoreWeights {
  market: number;
  tech: number;
  competition: number;
}

export function resolveGoalBand(targetMrr: number): GoalBand {
  if (targetMrr <= 20000) return 'niche-deep';
  if (targetMrr <= 200000) return 'growth-channel';
  return 'moat';
}

// 帯ごとの重み。重み合計はいずれも 3.5 なので、全帯で max は `5 * 3.5 = 17.5`
// (market=tech=comp=5 のとき)、min は `1 * 3.5 = 3.5`。Sonnet の raw スコアと
// 別次元になるが、ランキング用途なので絶対値ではなく同バッチ内の相対順序が担保されれば良い。
export function weightsFor(band: GoalBand): ScoreWeights {
  if (band === 'niche-deep') return { market: 1.0, tech: 1.0, competition: 1.5 };
  if (band === 'growth-channel') return { market: 1.5, tech: 1.0, competition: 1.0 };
  return { market: 1.5, tech: 0.8, competition: 1.2 };
}

// Sprint C-1: SNS バイラル依存度に応じた weighted_score の調整。
// high はバズ前提で再現性が低いため減点、low は流通設計が描けているので加点。
// 値は 3 軸合計が ~3.5〜17.5 のレンジなので、最大級の差 (1.0) でも順位逆転は限定的。
// 補正後の理論レンジは [2.5, 18.0]。numeric(4,2) (max 99.99) に収まるためクランプは不要。
const SNS_DEPENDENCY_DELTA: Record<DistributionHypothesis['sns_dependency'], number> = {
  high: -1.0,
  mid: 0,
  low: 0.5,
};

// 小数 2 桁で丸める (DB カラムは numeric(4,2))
// distribution は Sprint C-1 で導入。旧呼び出し (sns_dependency なし) は補正 0 として動作する。
export function computeWeightedScore(
  scored: Pick<
    SonnetScoredIdea,
    'market_score' | 'tech_score' | 'competition_score'
  >,
  weights: ScoreWeights,
  distribution?: Pick<DistributionHypothesis, 'sns_dependency'> | null,
): number {
  const raw =
    scored.market_score * weights.market +
    scored.tech_score * weights.tech +
    scored.competition_score * weights.competition;
  const snsDelta = distribution
    ? SNS_DEPENDENCY_DELTA[distribution.sns_dependency]
    : 0;
  return Math.round((raw + snsDelta) * 100) / 100;
}

export interface BandConfig {
  targetMrr: number;
  band: GoalBand;
  weights: ScoreWeights;
  logLine: string;
}

export function describeBandConfig(targetMrr: number = TARGET_MRR): BandConfig {
  const band = resolveGoalBand(targetMrr);
  const weights = weightsFor(band);
  const logLine = `target_mrr=${targetMrr} band=${band} weights=m${weights.market}/t${weights.tech}/c${weights.competition}`;
  return { targetMrr, band, weights, logLine };
}

// market_score / competition_score 足切り閾値。
// 個人開発で月 ¥10k に到達する条件として、(1) 一定の市場性、(2) 競合に埋もれない隙間、を必須化する。
// tech_score の足切りは撤廃: 技術難度が高くても「個人開発する意義」がある (= 既存大手が手を出しにくい)
// アイデアは挑戦したいため、技術難度では落とさない。
// 全帯共通 (帯ごとの「市場性が効くか・競合が効くか」は weighted_score の重みで調整済み)。
export const MARKET_SCORE_MIN = 3;
export const COMPETITION_SCORE_MIN = 3;
