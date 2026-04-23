// Haiku はアイデアを書かない。raw_signals を 3 種類のバンドルに分類するクラスタリング役。
// 後段で Sonnet × 3 役割 (集約者 / 結合者 / 隙間発見者) が各バンドルからアイデアを起草する。
//
// バンドル種別:
// - aggregator_bundles: 同じ痛みを指す 3+ signals のクラスタ
// - combinator_pairs:   痛み × 技術/情報 の掛け合わせ候補 (2+ signals 合計)
// - gap_candidates:     既存プロダクト告知 / 有料サービス言及 / 隣接ドメイン移植のネタ元 (1+ signals)
//
// 実装方針:
// - 全 signals を 1 回の Haiku 呼び出しに渡す (チャンク分割しない)。クラスタリング判定は
//   全体を俯瞰しないと精度が出ないため。signals が HAIKU_MAX_SIGNALS を超えたら上位の
//   新しい signal 優先でトリミングする (fetchUnprocessedSignals が collected_at DESC ソート済み)。
// - 無効な signal_id は Haiku 出力側から除外する。

import { z } from 'zod';
import { callParsed } from '../lib/anthropic.js';
import { HAIKU_MODEL } from '../lib/models.js';
import {
  CombinatorPairSchema,
  type HaikuClusterOutput,
  type HaikuSignalInput,
  type AggregatorBundle,
  type CombinatorPair,
  type GapCandidate,
} from '../types.js';

// LLM への JSON Schema ガイダンスと zod パースは共通の schema から生成されるが、
// Haiku が制約を外れた出力を返した場合 (signal_ids < 3 / angle が enum 外) に
// バッチ全体を潰さないよう、パース段階は lenient に受け取って filter 関数で正規化・除外する。
// strict な HaikuClusterOutput 型 (types.ts) を下流に返す契約は維持する。
const LenientAggregatorBundleSchema = z.object({
  theme: z.string().min(1),
  signal_ids: z.array(z.string()).min(1),
});

const VALID_GAP_ANGLES = [
  'launch_hn',
  'show_hn',
  'paid_service_mention',
  'niche_transfer',
  'other',
] as const;
type GapAngle = (typeof VALID_GAP_ANGLES)[number];
const VALID_GAP_ANGLE_SET = new Set<string>(VALID_GAP_ANGLES);

// Haiku の典型的タイポを enum に吸収するマップ。
// 観測例: "show_fn" を Show HN 系の hint と共に繰り返し返すケース (smoke 実行で 5/9 件)。
// 厳密一致で安全に corret するため、広めのファジーマッチはしない。
const GAP_ANGLE_TYPO_MAP: Record<string, GapAngle> = {
  show_fn: 'show_hn',
  launch_fn: 'launch_hn',
  showhn: 'show_hn',
  launchhn: 'launch_hn',
  'show-hn': 'show_hn',
  'launch-hn': 'launch_hn',
};

const LenientGapCandidateSchema = z.object({
  angle: z.string().min(1),
  hint: z.string().min(1),
  signal_ids: z.array(z.string()).min(1),
});

const LenientHaikuClusterOutputSchema = z.object({
  aggregator_bundles: z.array(LenientAggregatorBundleSchema),
  combinator_pairs: z.array(CombinatorPairSchema),
  gap_candidates: z.array(LenientGapCandidateSchema),
});
type LenientHaikuClusterOutput = z.infer<typeof LenientHaikuClusterOutputSchema>;
type LenientAggregatorBundle = LenientHaikuClusterOutput['aggregator_bundles'][number];
type LenientGapCandidate = LenientHaikuClusterOutput['gap_candidates'][number];

// 1 回で受け渡しできる上限。現状の 300-500 signals/日なら 1 回で収まる想定。
export const HAIKU_MAX_SIGNALS = 500;
// 出力は 3 種類の配列で、合計 30-60 個程度を想定。余裕を持って 8192 token。
const HAIKU_MAX_TOKENS = 8192;

const HAIKU_SYSTEM = `あなたは個人開発者向けアイデア発掘パイプラインのクラスタリング担当です。
与えられたシグナル (ブログ・技術投稿・Ask/Show/Launch HN など) を以下 3 種類に分類します。
アイデア文は書きません。後段の 3 役割 (集約者 / 結合者 / 隙間発見者) が各バンドルからアイデアを起草します。

# 3 種類のバンドル

## aggregator_bundles (集約者向け)
- 同じ痛みを複数のシグナルが訴えている場合、それらをまとめる
- 1 バンドルあたり signal_ids は 3 個以上 必須 (3 件未満は作らない)
- theme はそのクラスタの痛みを 1 行で説明する日本語の短文
- 「複数人が同じ困りごとを言っている」強いエビデンスだけを採用。1-2 件しか裏取れないなら他の 2 種類に回すか捨てる

## combinator_pairs (結合者向け)
- 「痛み 1 本」と「技術/情報/手法 1 本」を組み合わせて新しい解決策が発想できそうなペア
- pain_signal_ids: 痛み・愚痴・困りごとを含むシグナルの UUID 配列 (1 個以上)
- info_signal_ids: 新しい API / ライブラリ / 手法 / ノウハウを含むシグナルの UUID 配列 (1 個以上)
- pain_signal_ids と info_signal_ids は重複してはならない
- angle は「何と何の掛け合わせか」を短く (例: "新 OSS × 記事管理の面倒", "LLM Function Calling × SaaS 運用")

## gap_candidates (隙間発見者向け)
- 既存プロダクト告知 (Launch HN / Show HN) や有料サービス言及から「まだ誰も埋めていない隙間」を狙うネタ元
- 1 signal からでも成立する
- angle は必ず以下 5 つの文字列のいずれかを **そのまま文字通りコピー** して返すこと。
  - 接尾辞 "_hn" は **Hacker News (HN) の略**。h と n の 2 文字で終わる必要がある
  - 過去に "show_fn" / "launch_fn" と誤って返したケースを観測している。"_fn" / "_HN" / "showhn" / "show-hn" など別表記は一切許可しない:
  - "launch_hn": Launch HN や YC ローンチ告知。需要検証済み事例の隙間
  - "show_hn":   Show HN の自作プロダクト告知。隣接ドメインへの移植ネタ
  - "paid_service_mention": 有料サービスへの言及・批判・不満
  - "niche_transfer": 特定ドメインで成功している手法を別ドメインに持ち込むネタ
  - "other": 上記に当てはまらないが隙間として面白い単発シグナル
- hint はどの方向で隙間を狙うかの短文 (例: "非エンジニア向けに UI を落とし込む", "日本市場向け")

# 判定ルール

- 1 つのシグナルを複数のバンドル/候補に入れてもよい (集約バンドルに入れつつ隙間候補にも入れる等)
- ノイズ (単なるニュース紹介・自慢話・リリースノートのみで痛みが見えない) はどのバンドルにも入れない
- 日本語圏のシグナル中心なので、英語圏情報源 (HN) でも日本語で theme/angle/hint を書く
- 出力シグナル ID は入力の UUID をそのまま使う。存在しない UUID は使わない
- 候補が 0 件の種類があってもよい (該当なしなら空配列)

# 優先度ヒント

HN の hn_story_type (HN シグナルのみに付与):
- "launch" → gap_candidates の "launch_hn" に強く振る
- "show"   → gap_candidates の "show_hn" に強く振る
- "ask"    → 痛みが具体的な質問なので aggregator または combinator 候補
- "tell" / "normal" → 痛みが明確な場合のみ拾う`;

function buildUserPrompt(signals: HaikuSignalInput[]): string {
  return [
    `以下 ${signals.length} 件のシグナルをクラスタリングしてください。`,
    `各シグナルの id は UUID です。バンドルの signal_ids にはそのまま入力の UUID を使ってください。`,
    '',
    JSON.stringify(signals, null, 2),
  ].join('\n');
}

function filterAggregator(
  bundles: LenientAggregatorBundle[],
  validIds: Set<string>,
): AggregatorBundle[] {
  const out: AggregatorBundle[] = [];
  for (const b of bundles) {
    const ids = b.signal_ids.filter((id) => validIds.has(id));
    // 重複除外
    const unique = Array.from(new Set(ids));
    if (unique.length < 3) {
      console.warn(
        `[haiku] drop aggregator_bundle (valid_ids<3 after filter): theme="${b.theme}"`,
      );
      continue;
    }
    out.push({ theme: b.theme, signal_ids: unique });
  }
  return out;
}

function filterCombinator(
  pairs: CombinatorPair[],
  validIds: Set<string>,
): CombinatorPair[] {
  const out: CombinatorPair[] = [];
  for (const p of pairs) {
    const pain = Array.from(new Set(p.pain_signal_ids.filter((id) => validIds.has(id))));
    const infoRaw = Array.from(new Set(p.info_signal_ids.filter((id) => validIds.has(id))));
    // pain と info は重複不可
    const info = infoRaw.filter((id) => !pain.includes(id));
    if (pain.length < 1 || info.length < 1) {
      console.warn(
        `[haiku] drop combinator_pair (pain<1 or info<1 after filter): angle="${p.angle}"`,
      );
      continue;
    }
    out.push({ angle: p.angle, pain_signal_ids: pain, info_signal_ids: info });
  }
  return out;
}

function filterGap(
  gaps: LenientGapCandidate[],
  validIds: Set<string>,
): GapCandidate[] {
  const out: GapCandidate[] = [];
  for (const g of gaps) {
    const ids = Array.from(new Set(g.signal_ids.filter((id) => validIds.has(id))));
    if (ids.length < 1) {
      console.warn(
        `[haiku] drop gap_candidate (valid_ids<1 after filter): angle=${g.angle} hint="${g.hint}"`,
      );
      continue;
    }
    // Haiku が enum 外の angle を返した場合の正規化:
    //   1. タイポマップに一致すれば対応する正しい値に補正 (show_fn → show_hn など)
    //   2. それ以外は "other" にフォールバック
    let angle: GapAngle;
    if (VALID_GAP_ANGLE_SET.has(g.angle)) {
      angle = g.angle as GapAngle;
    } else {
      const corrected = GAP_ANGLE_TYPO_MAP[g.angle.toLowerCase().trim()];
      angle = corrected ?? 'other';
      console.warn(
        `[haiku] normalize gap_candidate.angle: "${g.angle}" → "${angle}" (hint="${g.hint}")`,
      );
    }
    out.push({ angle, hint: g.hint, signal_ids: ids });
  }
  return out;
}

export async function clusterSignals(
  signals: HaikuSignalInput[],
): Promise<HaikuClusterOutput> {
  if (signals.length === 0) {
    return { aggregator_bundles: [], combinator_pairs: [], gap_candidates: [] };
  }

  // 上限超過時は新しい signal 優先でトリム
  const trimmed = signals.length > HAIKU_MAX_SIGNALS ? signals.slice(0, HAIKU_MAX_SIGNALS) : signals;
  if (trimmed.length < signals.length) {
    console.warn(
      `[haiku] signals trimmed ${signals.length}→${trimmed.length} (max=${HAIKU_MAX_SIGNALS})`,
    );
  }

  console.log(`[haiku] cluster_input=${trimmed.length}`);

  const parsed = await callParsed({
    model: HAIKU_MODEL,
    system: HAIKU_SYSTEM,
    user: buildUserPrompt(trimmed),
    schema: LenientHaikuClusterOutputSchema,
    maxTokens: HAIKU_MAX_TOKENS,
    logPrefix: '[haiku cluster]',
  });

  const validIds = new Set(trimmed.map((s) => s.id));
  const aggregator = filterAggregator(parsed.aggregator_bundles, validIds);
  const combinator = filterCombinator(parsed.combinator_pairs, validIds);
  const gap = filterGap(parsed.gap_candidates, validIds);

  console.log(
    `[haiku] aggregator_bundles=${aggregator.length} combinator_pairs=${combinator.length} gap_candidates=${gap.length}`,
  );

  return {
    aggregator_bundles: aggregator,
    combinator_pairs: combinator,
    gap_candidates: gap,
  };
}
