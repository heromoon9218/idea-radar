// Sonnet 「集約者」役: 同じ痛みを指す 3+ signals のクラスタから堅実に裏取れた痛みを解決するアイデアを起草する。
// ハッカソンでいう「複数人の意見を整理して本質を抜き出すタイプ」のメンバー。

import { callParsed } from '../lib/anthropic.js';
import { SONNET_MODEL } from '../lib/models.js';
import {
  formatDemandSummaryForPrompt,
  type DemandSummary,
} from './demand-summary.js';
import { finalizeDraftCandidates } from './draft-filter.js';
import {
  DraftOutputSchema,
  type AggregatorBundle,
  type HaikuIdeaCandidate,
  type HaikuSignalInput,
} from '../types.js';

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

# フェルミ推定 (fermi_estimate) の必須化

各アイデアには「月 5 万円 (TARGET_MRR) に到達するための単価 × 顧客数」のフェルミ推定 を必ず付ける:
- unit_price:  想定単価 (円、整数)
- unit_type:   'monthly' (月額サブスク) / 'one_time' (買い切り) / 'per_use' (従量課金)
- mrr_formula: 「月額 500 円 × 100 人 = 50,000 円」「買い切り 3,000 円 × 月 17 本 = 51,000 円」のような 1 行の算式

フェルミ推定が成立しないアイデア (売り方が想像できない・単価を置けない) は candidates から自主的に除外する (raw_score を下げる)。

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

# 需要シグナルサマリの扱い

user prompt に「# 需要シグナルサマリ」セクション (累計 bkm / HN avg score / Zenn likes 等) が含まれる場合:
- それらは「痛みが複数人で裏取れているか」の定量指標。raw_score に反映する (高需要 → 加点、低需要 → 減点)
- WHY の本文に 1 箇所以上、定量引用 (「累計 240 bkm」「HN 平均 87pt」等) を含めて裏取りを可視化する
- サマリが提示されない場合はこの要件は不要
`;

interface InputArgs {
  bundle: AggregatorBundle;
  signalsById: Map<string, HaikuSignalInput>;
  demandSummary?: DemandSummary | null;
}

function buildUserPrompt({ bundle, signalsById, demandSummary }: InputArgs): string {
  const signals = bundle.signal_ids
    .map((id) => signalsById.get(id))
    .filter((s): s is HaikuSignalInput => s !== undefined);

  const sections: string[] = [
    '# クラスタ情報',
    `テーマ: ${bundle.theme}`,
    `シグナル数: ${signals.length}`,
    '',
  ];
  if (demandSummary) {
    sections.push(formatDemandSummaryForPrompt(demandSummary), '');
  }
  sections.push(
    '# 所属シグナル',
    JSON.stringify(signals, null, 2),
    '',
    'このクラスタの共通痛みを抜き出し、個人開発向けのアイデアを 1-2 個起草してください。',
    `source_signal_ids は以下の ${bundle.signal_ids.length} 個を全て含めてください:`,
    JSON.stringify(bundle.signal_ids),
  );
  return sections.join('\n');
}

export async function draftFromAggregatorBundle(
  args: InputArgs,
): Promise<HaikuIdeaCandidate[]> {
  const logPrefix = `[sonnet aggregator theme="${args.bundle.theme.slice(0, 30)}"]`;
  const parsed = await callParsed({
    model: SONNET_MODEL,
    system: AGGREGATOR_SYSTEM,
    user: buildUserPrompt(args),
    schema: DraftOutputSchema,
    maxTokens: SONNET_MAX_TOKENS,
    logPrefix,
    // 同役割内で複数バンドル処理するときに system が使い回されるので cache を効かせる
    cacheSystem: true,
  });

  // fermi_estimate 欠落アイデアは filter out、source_signal_ids は bundle.signal_ids で上書き保証
  return finalizeDraftCandidates({
    candidates: parsed.candidates,
    overrideSignalIds: args.bundle.signal_ids,
    logPrefix,
  });
}
