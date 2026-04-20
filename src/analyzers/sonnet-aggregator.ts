// Sonnet 「集約者」役: 同じ痛みを指す 3+ signals のクラスタから堅実に裏取れた痛みを解決するアイデアを起草する。
// ハッカソンでいう「複数人の意見を整理して本質を抜き出すタイプ」のメンバー。

import { callParsed } from '../lib/anthropic.js';
import {
  RoleIdeaOutputSchema,
  type AggregatorBundle,
  type HaikuIdeaCandidate,
  type HaikuSignalInput,
} from '../types.js';

export const SONNET_MODEL = 'claude-sonnet-4-6';
const SONNET_MAX_TOKENS = 3072;

const AGGREGATOR_SYSTEM = `あなたは個人開発アイデア発掘ハッカソンの「集約者」です。
3 人のブレストメンバーのうち、あなたの役割は 「複数シグナルで裏取れた痛み」 を堅実にアイデア化することです。

# あなたの思考様式

- バンドル内の複数シグナルに共通する「本質的な痛み」は何かを最初に言語化する
- その痛みに対し、個人開発者が 1-3 ヶ月で MVP を出せる規模のアイデアを 1-2 個 提案する
- 複数人が同じ痛みを訴えていることを武器にする — 「市場が確実に存在する」前提で書く
- category は dev-tool / productivity / saas / ai / other のいずれか

# 出力は WHY / WHAT / HOW の 3 フィールド

- why  (2-3 文): 誰が・いつ・どんな状況で・なぜ困っているか。ターゲット像を具体的に (職種 / 業界 / 規模感)。曖昧な主語 (「ユーザー」等) は禁止
- what (2-3 文): 何を作るか + 差別化ポイント + 収益モデル (月額 / 従量 / 買い切り 等、想定価格を入れる)
- how  (2-3 文): 技術スタック (使用 API / FW / DB 等) + MVP 最小構成 (実装するものの最小粒度) + 実装難度・期間感。ここが書けないアイデアは raw_score を下げる

# 出力条件

- 1 バンドルにつき 1 個 が基本。特に強い場合のみ 2 個まで
- raw_score (1-5) = 「個人開発候補としての筋の良さ」。5 = 今すぐ作りたい、3 = 条件次第、1 = 微妙
- source_signal_ids: バンドルの signal_ids を全て含める (削らない)
- 痛みが弱い・具体性を欠く場合は candidates: [] を返してよい

# 評価軸 (raw_score に反映)

- 軽量ドメイン (クリエイター・副業ワーカー・個人 EC・趣味クラスタ・自己管理層・個人投資家・小規模コミュニティ主催者 等) が月 $5-20 払う可能性が見える痛みか
  - **避けるべき重いドメイン**: 士業・医療介護・飲食店経営・中小製造業・建設リフォーム・エンプラ SaaS。商談サイクル長・既存ベンダー強固・個人開発で届かないため raw_score 2 以下に抑える
- レッドオーシャンではなく、個人開発者が入り込める隙間があるか
- PLG セルフサインアップで課金に到達できる経路があるか (商談・紹介営業が必須なら減点)
- HOW が具体的に書けるか (書けないアイデアは実装イメージが無い = 減点)
`;

interface InputArgs {
  bundle: AggregatorBundle;
  signalsById: Map<string, HaikuSignalInput>;
}

function buildUserPrompt({ bundle, signalsById }: InputArgs): string {
  const signals = bundle.signal_ids
    .map((id) => signalsById.get(id))
    .filter((s): s is HaikuSignalInput => s !== undefined);

  return [
    '# クラスタ情報',
    `テーマ: ${bundle.theme}`,
    `シグナル数: ${signals.length}`,
    '',
    '# 所属シグナル',
    JSON.stringify(signals, null, 2),
    '',
    'このクラスタの共通痛みを抜き出し、個人開発向けのアイデアを 1-2 個起草してください。',
    `source_signal_ids は以下の ${bundle.signal_ids.length} 個を全て含めてください:`,
    JSON.stringify(bundle.signal_ids),
  ].join('\n');
}

export async function draftFromAggregatorBundle(
  args: InputArgs,
): Promise<HaikuIdeaCandidate[]> {
  const parsed = await callParsed({
    model: SONNET_MODEL,
    system: AGGREGATOR_SYSTEM,
    user: buildUserPrompt(args),
    schema: RoleIdeaOutputSchema,
    maxTokens: SONNET_MAX_TOKENS,
    logPrefix: `[sonnet aggregator theme="${args.bundle.theme.slice(0, 30)}"]`,
    // 同役割内で複数バンドル処理するときに system が使い回されるので cache を効かせる
    cacheSystem: true,
  });

  // source_signal_ids は元の bundle.signal_ids で上書き保証
  return parsed.candidates.map((c) => ({
    ...c,
    source_signal_ids: args.bundle.signal_ids,
  }));
}
