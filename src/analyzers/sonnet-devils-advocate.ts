// Sprint B-1: Devil's advocate 2-pass スコアリング
// sonnet.ts の初回スコアリングの直後に別呼び出しで「このアイデアを却下すべき理由」を
// 1-5 件生成させ、その反論を踏まえて 3 軸を再スコアする。
//
// 狙い: 初回スコアリングは賛成側の論拠のみ見て判定しがちで甘く振れる傾向がある。
// 自分で書いたアイデアを自分で採点する構造的バイアスに対抗するため、同じ Sonnet に
// 「逆張りの視点から見ろ」と明示的に指示して再スコアリングする。
//
// 最終的に insert するのは revised スコア。初回スコアと rejection_reasons は
// ideas.devils_advocate jsonb に audit trail として保持する。

import { callParsed } from '../lib/anthropic.js';
import type { GoalBand } from '../lib/goal-band.js';
import { SONNET_MODEL } from '../lib/models.js';
import {
  DevilsAdvocateOutputSchema,
  type DevilsAdvocateOutput,
  type SonnetScoredIdea,
} from '../types.js';

const SONNET_MAX_TOKENS = 1536;

const DEVILS_ADVOCATE_SYSTEM_BASE = `あなたは個人開発アイデアの「反対尋問官 (Devil's advocate)」です。
初回採点が済んだアイデア 1 件に対し、まず 「このアイデアを却下すべき 3〜5 つの強い理由」 を挙げ、
その上で 3 軸 (market_score / tech_score / competition_score) を再スコアリングします。

# あなたの思考様式

- 甘い採点バイアスを壊すのが目的。肯定的な要素は脇に置き、「現実的にこのアイデアがコケる道筋」だけを言語化する
- 「強い理由」とは、反証できない or 反証に高コストがかかるタイプの指摘。「よく分からない」「可能性が低い」ではなく
  「既に X という競合が無料枠を持つ」「ターゲットが実在しても課金導線がない」「実装の勘所を LLM が誤解している」のような具体的指摘
- 却下理由を出したら、それを踏まえて 3 軸を **下げる方向に再採点** する (上げるのは初回採点が明らかに保守的だった場合のみ)
- 再採点は 1-5 の整数。変更なしでも可だが、その場合 verdict で「却下理由はあるが最終判断は維持」と明示する

# 評価軸のリマインド

- market_score:       潜在ユーザー数・支払意欲
- tech_score:         技術難度の低さ (個人開発で MVP に届くか)
- competition_score:  競合の少なさ・差別化のしやすさ

# 出力ルール

- rejection_reasons: 最低 1 件、最大 5 件。各要素は独立した 1-2 文
- reconsidered_*_score: 1-5 の整数 (初回スコアを出発点に、却下理由を踏まえて上下させる)
- verdict: 最終判断サマリ 1-2 文。「却下理由 X が最も重く、全体としては △△ と評価」のように、
  初回採点との差分を言語化する

# 禁止事項

- 初回採点を無視した独自採点にしない (あくまで「反論を踏まえた修正」)
- 却下理由を 5 件を超えて出さない (薄い指摘の羅列は signal/noise を悪化させる)
- 「要検討」「可能性は否定できない」のような曖昧な rejection_reasons は出さない`;

function bandGuidance(band: GoalBand, targetMrr: number): string {
  if (band === 'niche-deep') {
    return `\n# 現在のゴール帯: niche-deep (月収目標 ${targetMrr.toLocaleString('en-US')} 円以下)\n却下理由の焦点: 「コアユーザー数が二桁に届かない」「ニッチ内でも課金意欲が確認できない」が効く。`;
  }
  if (band === 'growth-channel') {
    return `\n# 現在のゴール帯: growth-channel (月収目標 ${targetMrr.toLocaleString('en-US')} 円前後)\n却下理由の焦点: 「後追い競合に半年で蹴散らされる」「セルフサインアップ導線が組めない」「支払文化が薄いターゲットに課金を期待」が効く。`;
  }
  return `\n# 現在のゴール帯: moat (月収目標 ${targetMrr.toLocaleString('en-US')} 円以上)\n却下理由の焦点: 「参入障壁を積めない (データ・規制・ネットワーク効果がない)」「大手が片手間で潰せる」が効く。`;
}

function buildSystem(band: GoalBand, targetMrr: number): string {
  return `${DEVILS_ADVOCATE_SYSTEM_BASE}\n${bandGuidance(band, targetMrr)}`;
}

interface BuildArgs {
  scored: SonnetScoredIdea;
}

function buildUserPrompt({ scored }: BuildArgs): string {
  return [
    '# 初回採点済みアイデア',
    JSON.stringify(
      {
        title: scored.title,
        why: scored.why,
        what: scored.what,
        how: scored.how,
        category: scored.category,
        initial_scores: {
          market_score: scored.market_score,
          tech_score: scored.tech_score,
          competition_score: scored.competition_score,
        },
        competitors: scored.competitors,
      },
      null,
      2,
    ),
    '',
    '上記アイデアを却下すべき 3〜5 つの強い理由 を挙げ、それを踏まえて 3 軸を再採点してください。',
  ].join('\n');
}

export interface CritiqueOptions {
  band: GoalBand;
  targetMrr: number;
}

export async function critiqueAndRescore(
  scored: SonnetScoredIdea,
  { band, targetMrr }: CritiqueOptions,
): Promise<DevilsAdvocateOutput> {
  return callParsed({
    model: SONNET_MODEL,
    system: buildSystem(band, targetMrr),
    user: buildUserPrompt({ scored }),
    schema: DevilsAdvocateOutputSchema,
    maxTokens: SONNET_MAX_TOKENS,
    logPrefix: `[sonnet devils_advocate "${scored.title.slice(0, 40)}"]`,
    // 同 system で Top 10 を連続批評するので cache ヒット (帯は 1 バッチ内固定)
    cacheSystem: true,
  });
}
