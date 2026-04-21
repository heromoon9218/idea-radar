// 個人開発の月収ゴール (TARGET_MRR) に基づいて、スコアリング rubric と
// weighted_score の重みを切り替える。analyze.ts / smoke.ts で共有。
//
// 帯の設計方針 (Sprint A-3):
//   ≤ 20,000 円         niche-deep     : コアユーザーへの深掘り。競合厚みは関係ない
//   20,001〜200,000 円  growth-channel : 持続性・流通設計・支払文化が効き始める境目
//   > 200,000 円        moat           : 参入障壁 (データ / ネットワーク効果 / 規制)

import type { SonnetScoredIdea } from '../types.js';

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

// 帯ごとの重み。max は `1 * 1.5 + 1 * 1.5 + 1 * 1.5 = 22.5` (niche-deep で market=tech=comp=5)
// など帯により 15〜22.5 の範囲。Sonnet の raw スコアと別次元になるが、
// ランキング用途なので絶対値ではなく同バッチ内の相対順序が担保されれば良い。
export function weightsFor(band: GoalBand): ScoreWeights {
  if (band === 'niche-deep') return { market: 1.0, tech: 1.0, competition: 1.5 };
  if (band === 'growth-channel') return { market: 1.5, tech: 1.0, competition: 1.0 };
  return { market: 1.5, tech: 0.8, competition: 1.2 };
}

// 小数 2 桁で丸める (DB カラムは numeric(4,2))
export function computeWeightedScore(
  scored: Pick<
    SonnetScoredIdea,
    'market_score' | 'tech_score' | 'competition_score'
  >,
  weights: ScoreWeights,
): number {
  const raw =
    scored.market_score * weights.market +
    scored.tech_score * weights.tech +
    scored.competition_score * weights.competition;
  return Math.round(raw * 100) / 100;
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

// tech_score 足切り閾値。これ未満の idea は個人開発で MVP まで辿り着けない可能性が高いため、
// analyze 側で ideas insert の対象から除外する。全帯共通 (技術難度は帯に依存しない)。
export const TECH_SCORE_MIN = 3;
