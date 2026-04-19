// Sonnet 「結合者」役: 痛み × 技術/情報 の掛け合わせで新しい解決策を発想する。
// ハッカソンでいう「A と B を結びつけて面白い組み合わせを生むタイプ」のメンバー。

import { callParsed } from '../lib/anthropic.js';
import {
  RoleIdeaOutputSchema,
  type CombinatorPair,
  type HaikuIdeaCandidate,
  type HaikuSignalInput,
} from '../types.js';

export const SONNET_MODEL = 'claude-sonnet-4-6';
const SONNET_MAX_TOKENS = 3072;

const COMBINATOR_SYSTEM = `あなたは個人開発アイデア発掘ハッカソンの「結合者」です。
3 人のブレストメンバーのうち、あなたの役割は 「痛み × 技術/情報 の掛け合わせ」 で新しい解決策を発想することです。

# あなたの思考様式

- 与えられる pain signals には「困りごと・愚痴・具体的な質問」が含まれる
- 与えられる info signals には「新しい API / ライブラリ / 手法 / 運用ノウハウ」が含まれる
- あなたの仕事は 「その情報 (info) を活用して、この痛み (pain) を解く」アイデア を 1-2 個生み出すこと
- pain も info も 1 本ずつしか提示されないケースがあるが、組み合わせ自体が新しければ価値がある
- 「この新 API が使えるなら、あの面倒な作業が週末で片付くのでは」という発想を優先する
- 技術の目新しさではなく、「痛みが確実に軽減される」道筋を書く

# 出力条件

- 1 ペアにつき 1-2 個
- pain_summary: 痛みの側を 2-3 文で具体的に
- idea_description: info (技術/情報) を活用してどう解決するかを 3-4 文で。情報源の技術名を必ず引用する
- category: dev-tool / productivity / saas / ai / other
- raw_score (1-5) = 組み合わせの筋の良さ。5 = 「こんなの絶対欲しい」、1 = 苦しい組み合わせ
- source_signal_ids: pain_signal_ids + info_signal_ids を全て含める (両方必須)
- 掛け合わせが苦しい場合は candidates: [] を返してよい

# 評価軸 (raw_score に反映)

- 非エンジニア / B2B 小口が月 $5-20 払う可能性
- 情報側の技術が個人開発で手に届くレベルか (研究課題レベルなら NG)
- 既存競合が同じ組み合わせを実装していない「隙間」があるか
`;

interface InputArgs {
  pair: CombinatorPair;
  signalsById: Map<string, HaikuSignalInput>;
}

function buildUserPrompt({ pair, signalsById }: InputArgs): string {
  const pickMany = (ids: string[]): HaikuSignalInput[] =>
    ids
      .map((id) => signalsById.get(id))
      .filter((s): s is HaikuSignalInput => s !== undefined);

  const pain = pickMany(pair.pain_signal_ids);
  const info = pickMany(pair.info_signal_ids);
  const allIds = [...pair.pain_signal_ids, ...pair.info_signal_ids];

  return [
    '# 掛け合わせ観点',
    pair.angle,
    '',
    `# 痛み (pain) 側シグナル: ${pain.length} 件`,
    JSON.stringify(pain, null, 2),
    '',
    `# 情報 (info) 側シグナル: ${info.length} 件`,
    JSON.stringify(info, null, 2),
    '',
    '上記の情報を活用して痛みを解くアイデアを 1-2 個起草してください。',
    `source_signal_ids は以下の ${allIds.length} 個 (pain + info) を全て含めてください:`,
    JSON.stringify(allIds),
  ].join('\n');
}

export async function draftFromCombinatorPair(
  args: InputArgs,
): Promise<HaikuIdeaCandidate[]> {
  const allIds = [...args.pair.pain_signal_ids, ...args.pair.info_signal_ids];

  const parsed = await callParsed({
    model: SONNET_MODEL,
    system: COMBINATOR_SYSTEM,
    user: buildUserPrompt(args),
    schema: RoleIdeaOutputSchema,
    maxTokens: SONNET_MAX_TOKENS,
    logPrefix: `[sonnet combinator angle="${args.pair.angle.slice(0, 30)}"]`,
    cacheSystem: true,
  });

  return parsed.candidates.map((c) => ({
    ...c,
    source_signal_ids: allIds,
  }));
}
