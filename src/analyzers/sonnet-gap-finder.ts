// Sonnet 「隙間発見者」役: 既存プロダクト告知 / 有料サービス言及 / 隣接ドメイン移植から
// まだ誰も埋めていない隙間を狙うアイデアを起草する。
// ハッカソンでいう「既にある物を別業界に持ち込むタイプ」のメンバー。

import { callParsed } from '../lib/anthropic.js';
import {
  RoleIdeaOutputSchema,
  type GapCandidate,
  type HaikuIdeaCandidate,
  type HaikuSignalInput,
} from '../types.js';

export const SONNET_MODEL = 'claude-sonnet-4-6';
const SONNET_MAX_TOKENS = 3072;

const GAP_FINDER_SYSTEM = `あなたは個人開発アイデア発掘ハッカソンの「隙間発見者」です。
3 人のブレストメンバーのうち、あなたの役割は 「既存プロダクトや有料サービスの穴を狙う」 発想をすることです。
あなたのモットー: 「新しい需要を創造するより、既に金が動いている領域の未充足ポイントを拾う」。

# あなたが使う発想パターン

- **launch_hn**: Launch HN や YC バッチ告知は需要検証済みの事例。「このプロダクトは X をカバーしていない」「日本市場向けは未対応」「エンプラ向けなので個人向け版が空いている」などの隙間を狙う
- **show_hn**: Show HN の自作プロダクト告知は「あるドメインで成功しているパターン」。これを別業界・別ユーザー層 (非エンジニア・B2B 小口・非英語圏) に移植する
- **paid_service_mention**: 有料サービスへの言及・批判・不満。代替プロダクト or その弱点を埋めるアドオン
- **niche_transfer**: 特定ドメインの手法を別ドメインに持ち込む (例: AI × 士業、開発者向け DX → 非エンジニア職の DX)
- **other**: 上記以外の「隙間が見える」単発シグナル。自由に発想してよい

# あなたの思考様式

- 「個人開発者が今から作る DevTool」ではなく、「金が動いているが手薄な領域」を最優先する
- 非エンジニア / 特定業界 / B2B 小口 / 非英語圏 を武器にする
- 「既存プロダクトをベースに、どこをズラすと金になるか」を言語化する
- 1 signal からでも成立する。シグナルは発想の「起点」として扱い、一般知識で補強してよい

# 出力条件

- 1 候補につき 1-2 個
- pain_summary: 「現在のプロダクトの何がカバーされていないか」を 2-3 文で
- idea_description: 「どうズラすか + ターゲット層 + 最小構成」を 3-4 文で。ターゲット層 (非エンジニア / 中小製造業 / 個人商店 / 特定趣味クラスタなど) を必ず書く
- category: dev-tool / productivity / saas / ai / other
- raw_score (1-5): 「個人開発で月 $5-20 を取れる筋の良さ」。競合回避と支払意欲の両立を評価
- source_signal_ids: 入力の signal_ids を全て含める

# 評価軸 (raw_score に反映)

- 支払意欲のある非エンジニア層がターゲットになっているか
- 既存プロダクトを模倣しただけのレッドオーシャンになっていないか (ズラしの角度が効いているか)
- 個人開発者が 1-3 ヶ月で MVP を出せる規模か
`;

interface InputArgs {
  candidate: GapCandidate;
  signalsById: Map<string, HaikuSignalInput>;
}

function buildUserPrompt({ candidate, signalsById }: InputArgs): string {
  const signals = candidate.signal_ids
    .map((id) => signalsById.get(id))
    .filter((s): s is HaikuSignalInput => s !== undefined);

  return [
    '# 隙間候補情報',
    `angle: ${candidate.angle}`,
    `hint:  ${candidate.hint}`,
    '',
    `# 起点シグナル: ${signals.length} 件`,
    JSON.stringify(signals, null, 2),
    '',
    'このシグナルを起点に「既存の穴」「ドメイン移植」「ターゲット層のズラし」のいずれかでアイデアを 1-2 個起草してください。',
    `source_signal_ids は以下の ${candidate.signal_ids.length} 個を全て含めてください:`,
    JSON.stringify(candidate.signal_ids),
  ].join('\n');
}

export async function draftFromGapCandidate(
  args: InputArgs,
): Promise<HaikuIdeaCandidate[]> {
  const parsed = await callParsed({
    model: SONNET_MODEL,
    system: GAP_FINDER_SYSTEM,
    user: buildUserPrompt(args),
    schema: RoleIdeaOutputSchema,
    maxTokens: SONNET_MAX_TOKENS,
    logPrefix: `[sonnet gap_finder angle=${args.candidate.angle}]`,
    cacheSystem: true,
  });

  return parsed.candidates.map((c) => ({
    ...c,
    source_signal_ids: args.candidate.signal_ids,
  }));
}
