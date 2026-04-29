// Sprint B-1 (両側評価版): Critical reviewer 2-pass スコアリング
// sonnet.ts の初回スコアリングの直後に別呼び出しで「このアイデアを却下すべき理由」と
// 「初回採点が見落としている強み (過小評価された点)」の両方を生成させ、両者の重みを
// 比較して 3 軸を再スコアする。
//
// 旧版の問題: 「却下理由のみを挙げ、下げる方向に再採点する」という片側プロンプトで、
// 56 件中 56 件が delta_sum マイナスに張り付き、market_score < 3 で全件足切りされた。
// (2026-04-28 analyze run で観測)
//
// 新版の狙い:
//   - 「下げる」と「上げる」を等しく検討させる構造で、初回スコアの系統的バイアスを
//     片側に寄らない形で補正する
//   - 「変動なし」も明示的な選択肢として持たせる (両論を検討した上で初回判定維持なら +0)
//   - 強い棄却理由が複数ある場合は従来通り減点される (フィルタ機能は維持)
//
// 最終的に insert するのは revised スコア。初回スコアと両側理由は
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

const DEVILS_ADVOCATE_SYSTEM_BASE = `あなたは個人開発アイデアの「批判的レビュワー (両側評価担当)」です。
初回採点が済んだアイデア 1 件に対し、以下の 2 つを **同時に** 挙げ、その上で 3 軸 (market_score / tech_score / competition_score) を再スコアします。

  A. rejection_reasons (却下すべき強い理由 / 初回採点が **過大評価** している点)
  B. upgrade_reasons   (初回採点が **過小評価** している強み / 見落とされたポジティブ要素)

# あなたの思考様式

- 系統的バイアス対策が目的。初回採点は単一視点で行われるため上下どちらにもブレうる。
  あなたは「下げる視点」と「上げる視点」を **対称に** 持ち込んで補正する役割
- A だけ書いて B を空にする / B だけ書いて A を空にする のは、本当にどちらか一方しか
  論拠が立たない場合のみ許可。多くのアイデアは両方の論拠が立つはずなので両方埋めること
- A の例: 「既に X という競合が無料枠を持つ」「ターゲットは実在しても課金導線がない」
  「実装の勘所を LLM が誤解している」のような **反証コストが高い** 具体的指摘
- B の例: 「初回採点が見落としているニッチセグメント (例: ○○業界の 50 人規模) には強い支払文化がある」
  「カテゴリ全体は競合が厚いが、この切り口の組合せは確認できる範囲に競合不在」
  「日本語 UI / コンプライアンス対応で日本市場に限れば差別化が立つ」など
- 両側の論拠を並べたら、**重みを比較して再採点を決める**:
    - A の論拠が B より重い → 初回より下げる (-1〜-2)
    - B の論拠が A より重い → 初回より上げる (+1〜+2)
    - 両者拮抗 / どちらも弱い → 初回維持 (±0)
- 再採点は 1-5 の整数。**変更なし (±0) は正当な選択肢** で、両論を検討した上で
  「初回判定が妥当」と結論したら verdict にその旨を書く

# 評価軸のリマインド

- market_score:       潜在ユーザー数・支払意欲
- tech_score:         技術難度の低さ (個人開発で MVP に届くか)
- competition_score:  競合の少なさ・差別化のしやすさ

# 出力ルール

- rejection_reasons: 0〜5 件。空配列 [] も可だが、A・B のいずれかは最低 1 件埋めること
- upgrade_reasons:   0〜5 件。空配列 [] も可だが、A・B のいずれかは最低 1 件埋めること
- 各要素は独立した 1-2 文の具体的指摘
- reconsidered_*_score: 1-5 の整数 (初回スコアを出発点に、両側理由の重み比較で上下させる)
- verdict: 最終判断サマリ 1-2 文。「A の X 理由が最も重く全体としては -2 / 初回判定維持 / B の Y を踏まえ +1」
  のように、**どちらの側がどれだけ効いたか** を言語化する

# 禁止事項

- 「下げる方向に必ず動かす」「上げる方向に必ず動かす」のような偏った再採点。両論を検討した中立判定が必須
- 初回採点を無視した独自採点 (あくまで「両側の論拠を踏まえた修正」)
- 各 reasons を 5 件を超えて出さない (薄い指摘の羅列は signal/noise を悪化させる)
- 「要検討」「可能性は否定できない」のような曖昧な reasons (A/B 両方とも具体性が必要)
- A と B を **両方とも空配列** にすること (片方は必ず埋める)`;

function bandGuidance(band: GoalBand, targetMrr: number): string {
  if (band === 'niche-deep') {
    return `\n# 現在のゴール帯: niche-deep (月収目標 ${targetMrr.toLocaleString('en-US')} 円以下)
- A の焦点: 「コアユーザー数が二桁に届かない」「ニッチ内でも課金意欲が確認できない」
- B の焦点: 「mass market では 3 止まりだが、ニッチ ○○ 領域に絞れば支払意欲のあるコアユーザー 10〜50 人が見える」`;
  }
  if (band === 'growth-channel') {
    return `\n# 現在のゴール帯: growth-channel (月収目標 ${targetMrr.toLocaleString('en-US')} 円前後)
- A の焦点: 「後追い競合に半年で蹴散らされる」「セルフサインアップ導線が組めない」「支払文化が薄いターゲットに課金を期待」
- B の焦点: 「カテゴリ全体は競合厚いが、この切り口は確認可能な競合不在」「データ / コミュニティ / 統合の堀が芽として見える」「支払文化の強い層 (B2B 小口 / 開発者 / 専門職) が含まれている」`;
  }
  return `\n# 現在のゴール帯: moat (月収目標 ${targetMrr.toLocaleString('en-US')} 円以上)
- A の焦点: 「参入障壁を積めない (データ・規制・ネットワーク効果がない)」「大手が片手間で潰せる」
- B の焦点: 「規制 / データ蓄積 / 統合の組合せで参入障壁が立ち上がる芽がある」「大手が片手間で来るには専門性 / コンプラの壁がある」`;
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
    '上記アイデアに対し、却下すべき理由 (A: rejection_reasons) と 初回採点が見落としている強み (B: upgrade_reasons) を **両方** 挙げ、両者の重みを比較して 3 軸を再採点してください。両論拮抗なら初回維持 (±0) を選択してください。',
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
    // 同 system で全候補を連続批評するので cache ヒット (帯は 1 バッチ内固定)
    cacheSystem: true,
  });
}
