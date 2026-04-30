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

// Haiku は systematic に gap_candidate.angle 末尾を外す:
// 観測例 (smoke 各回): "show_fn" / "show_hm" / "launch_fn" / "launch_hm"。
// prefix (show / launch) と "_h" までは安定して出すので、末尾 1-3 文字のブレを正規表現で吸収する。
// プロンプトでの semantic anchor 強化や厳密一致マップ拡張では補正しきれない (run ごとに別の suffix を返すため)。
function fuzzyMatchGapAngle(normalized: string): GapAngle | null {
  if (/^show[_-]?h.{0,3}$/.test(normalized)) return 'show_hn';
  if (/^launch[_-]?h.{0,3}$/.test(normalized)) return 'launch_hn';
  return null;
}

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

// 1 回で受け渡しできる上限。SE 主要化の初回 ingest で最大 800 件程度のスパイクが来るため 700 に拡張。
// Haiku 4 の input は 200k tokens。SE 本文 1500 chars 込みの実測で 1 signal ≒ 287 tokens
// (700 signals で 201k tokens となり 200k 上限を超えた、2026-04-26 CI 失敗)。
// 対策として buildUserPrompt 側で content を HAIKU_CONTENT_MAX_CHARS に切り詰めてから JSON 化する。
// 700 signals × ~200 tokens/signal (切り詰め後) + system/schema 5k ≒ 145k tokens で収まる想定。
export const HAIKU_MAX_SIGNALS = 700;
// 出力は 3 種類の配列で、合計 30-60 個程度を想定。余裕を持って 8192 token。
const HAIKU_MAX_TOKENS = 8192;
// Haiku は痛みのクラスタリング判定だけ行うので本文の細部は不要。
// SE は collection 時点で 1500 chars cap、Hatena/Zenn/HN は元から短い。
// 800 chars あればクラスタ判定の根拠は読み取れる (Sonnet drafter は signalsById 経由で
// 元の content にアクセスできるので、詳細起草の段階では full body が使える)。
const HAIKU_CONTENT_MAX_CHARS = 800;

const HAIKU_SYSTEM = `あなたは個人開発者向けアイデア発掘パイプラインのクラスタリング担当です。
与えられたシグナルを以下 3 種類に分類します。アイデア文は書きません。
後段の 3 役割 (集約者 / 結合者 / 隙間発見者) が各バンドルからアイデアを起草します。

# シグナルの構成

入力には 2 系統のソースが混ざっています:

1. **非技術ペイン + 支払文化系ニッチ (主)**: Stack Exchange の 14 サイト (parenting / money / workplace /
   cooking / diy / travel / pets / gardening / fitness / law / outdoors / expatriates / freelancing /
   pm)。生活者が具体的に困って人に聞いているペイン + フリーランス・PM 等の支払文化のあるニッチ。
   source=stackexchange で識別。
2. **技術・情報 (副)**: Zenn / はてブ / Hacker News。技術記事、ツール紹介、Show/Ask/Launch HN 等。
   新 API・ライブラリ・手法・既存プロダクト告知を含む。source=zenn / hatena / hackernews で識別。

# combinator_pairs の SE 由来 pain 優先方針

このパイプラインは「日常生活・支払文化系の非技術ペイン × 技術 info で個人開発する」を主目的としており、
SE 系 pain × 技術系 info の角度で成立する組み合わせが質的に最良の出力となる
(個人開発で月 5 万円を狙うには非技術ペインの方が PLG 課金に載りやすいため)。

判断ルール:
- 入力に source=stackexchange のシグナルが含まれ、それが具体的なペインを訴えていて、
  かつ SE 由来 pain を使った成立可能な組み合わせがあるなら、**tech-tech ペアより優先採用する**
- ただし数値ノルマ (「最低 N ペア」) は課さない。SE 由来で成立する組み合わせが無ければ
  無理に作らず、tech-tech ペアや他の角度で組成してよい。**質を捏造より優先する**
- combinator_pairs の info 側には技術系シグナル (Zenn / はてブ / HN) を置くのが素直な方向

# 3 種類のバンドル

## aggregator_bundles (集約者向け)
- 同じ痛みを複数のシグナルが訴えている場合、それらをまとめる
- 1 バンドルあたり signal_ids は **5 個以上必須** (5 件未満は作らない、2026-04-29 引き上げ)
- theme はそのクラスタの痛みを 1 行で説明する日本語の短文
- 「複数人が同じ困りごとを言っている」強いエビデンスだけを採用。4 件以下しか裏取れないなら他の 2 種類に回すか捨てる

## combinator_pairs (結合者向け)
- 「痛み 1 本」と「技術/情報/手法 1 本」を組み合わせて新しい解決策が発想できそうなペア
- pain_signal_ids: 痛み・愚痴・困りごとを含むシグナルの UUID 配列 (1 個以上)
- info_signal_ids: 新しい API / ライブラリ / 手法 / ノウハウを含むシグナルの UUID 配列 (1 個以上)
- **pain_signal_ids + info_signal_ids 合計は 3 個以上必須** (合計 2 件以下は作らない、2026-04-29 引き上げ)
- pain_signal_ids と info_signal_ids は重複してはならない
- angle は「何と何の掛け合わせか」を短く (例: "新 OSS × 記事管理の面倒", "LLM Function Calling × SaaS 運用")

## gap_candidates (隙間発見者向け)
- 既存プロダクト告知 (Launch HN / Show HN) や有料サービス言及から「まだ誰も埋めていない隙間」を狙うネタ元
- signal_ids は angle ごとに最低件数が異なる (2026-04-29 引き上げ):
  - "launch_hn" / "show_hn": **1 個以上**で OK (1 post 単独で需要検証済み事例として成立)
  - "paid_service_mention" / "niche_transfer" / "other": **2 個以上必須** (1 件単独だと弱いネタ元が多いため除外)
- angle は必ず以下 5 つの文字列のいずれかを **そのまま文字通りコピー** して返すこと。
  タイポ・省略・別表記 (例: "show_fn", "show_hm", "showhn", "show-hn") は一切許可しない:
  - "launch_hn": Launch HN や YC ローンチ告知。需要検証済み事例の隙間
  - "show_hn":   Show HN の自作プロダクト告知。隣接ドメインへの移植ネタ
  - "paid_service_mention": 有料サービスへの言及・批判・不満
  - "niche_transfer": 特定ドメインで成功している手法を別ドメインに持ち込むネタ
  - "other": 上記に当てはまらないが隙間として面白い単発シグナル
- hint はどの方向で隙間を狙うかの短文 (例: "非エンジニア向けに UI を落とし込む", "日本市場向け")

# 判定ルール

- 1 つのシグナルを複数のバンドル/候補に入れてもよい (集約バンドルに入れつつ隙間候補にも入れる等)
- ノイズ (単なるニュース紹介・自慢話・リリースノートのみで痛みが見えない) はどのバンドルにも入れない
- 英語圏ソース (HN / Stack Exchange) のシグナルでも、theme / angle / hint は全て日本語で書く
- 出力シグナル ID は入力の UUID をそのまま使う。存在しない UUID は使わない
- 候補が 0 件の種類があってもよい (該当なしなら空配列)

# 優先度ヒント

HN の hn_story_type (HN シグナルのみに付与):
- "launch" → gap_candidates の "launch_hn" に強く振る
- "show"   → gap_candidates の "show_hn" に強く振る
- "ask"    → 痛みが具体的な質問なので aggregator または combinator 候補
- "tell" / "normal" → 痛みが明確な場合のみ拾う

Stack Exchange の se_site (Stack Exchange シグナルのみに付与、14 サイト):
- "parenting"     → 育児 (乳幼児ケア・教育・家族関係)
- "money"         → 家計・個人投資・副業・税金・保険
- "workplace"     → 職場 (上司・同僚・評価・転職・リモートワーク)
- "cooking"       → 料理 (レシピ・食材管理・食品保存・調理器具)
- "diy"           → DIY (住居修繕・工具・配線・配管・補修)
- "travel"        → 旅行 (旅程・交通・宿泊・現地手続き・ビザ)
- "pets"          → ペット (犬猫・健康・しつけ・食事)
- "gardening"     → 園芸 (植物育成・病害虫・土壌・水やり)
- "fitness"       → フィットネス (運動・栄養・怪我・ダイエット)
- "law"           → 法律 (一般人の法律トラブル・契約・規制)
- "outdoors"      → アウトドア (キャンプ・登山・釣り・装備)
- "expatriates"   → 海外在住 (ビザ・引越し・生活適応・送金)
- "freelancing"   → フリーランス実務 (請求・契約・税務・クライアント対応・案件獲得)
                    支払文化が強い層: 個人事業主は道具にお金を払う、PLG 課金の主戦場
- "pm"            → プロジェクト管理 (進捗・リスク管理・チーム調整・PM 手法・ツール選定)
                    支払文化が強い層: PM はツール導入決裁権あり、B2B 小口の主戦場
Stack Exchange の質問は「具体的に困って人に聞いている」純度が高いため、
**必ず痛みシグナルとして扱い** aggregator_bundles か combinator_pairs の pain 側に配置する。
info_signal_ids に SE を入れてはならない (SE は情報源ではなく痛み源)。

特に freelancing / pm の 2 サイトは支払文化が強いので、
これらをコアにした集約バンドル / 結合ペアは個人開発の月 5 万円達成と直結しやすい。
痛みが薄くてもこれら 2 サイト由来の signal は積極的にバンドル化対象にしてよい。

combinator_pairs 組成の推奨パターン:
- pain: SE の具体ペイン (例: "freelancing" の請求書テンプレ管理の愚痴)
- info: 技術系ソース (例: Zenn の新 PDF 生成 API 解説記事)
- angle: "フリーランス請求書管理の痛み × PDF 生成 API で月額 500 円 SaaS"

# heavy_domain フラグ (全ソース横断、true のときのみ付与)

heavy_domain=true は collect 時の早期判定で「個人開発の流通域を超える重いドメイン」と
タグ付けされた signal を意味します:
- 士業 (税理士・弁護士・会計士・司法書士・社労士事務所): 商談サイクルが長く既存ベンダーが固い
- 医療・介護: 規制 (薬機法 / SaMD) と保険点数の壁、個人開発で運用しきれない
- 飲食店経営・宿泊経営: 既存 POS / 予約システムが寡占
- 中小製造業・建設業・リフォーム業: 代理店 / 直営業ネットワーク必須
- エンタープライズ SaaS / SAP / Salesforce 連携: 営業組織必須

これらの signal は **aggregator_bundles と combinator_pairs の pain 側に入れない**。
gap_candidates の other に分類するか、痛みが薄ければバンドルに入れずに捨てる。
ただし以下の例外は認める:
- "freelancing" の SE 質問が medical 案件を扱っているケース → freelancing 側のペインとして扱う
  (個人事業主の実務痛みであり、個人開発で届く層なので aggregator OK)
- 個人投稿 (HN や Zenn) で「医療現場の不便」を当事者として語っているケース → 個人体験の痛みなので gap_candidates に入れてよい

# payment_intent フラグ (HN normal 救済時のみ true 付与)

payment_intent=true の signal は「I'd pay $X for...」「willing to pay」「subscribe to...」など
明示的な支払意欲が観測されたシグナルです。score が低くても支払文化シグナルとして強いので、
aggregator_bundles のコア要素として優先採用してよい (痛み 1 件としての重みを 2 倍程度に扱う)。`;

function truncateForHaiku(s: HaikuSignalInput): HaikuSignalInput {
  if (s.content === null || s.content.length <= HAIKU_CONTENT_MAX_CHARS) return s;
  return { ...s, content: s.content.slice(0, HAIKU_CONTENT_MAX_CHARS) };
}

function buildUserPrompt(signals: HaikuSignalInput[]): string {
  const truncated = signals.map(truncateForHaiku);
  return [
    `以下 ${truncated.length} 件のシグナルをクラスタリングしてください。`,
    `各シグナルの id は UUID です。バンドルの signal_ids にはそのまま入力の UUID を使ってください。`,
    '',
    JSON.stringify(truncated, null, 2),
  ].join('\n');
}

// 2026-04-29 引き上げ → 2026-04-30 部分 revert: aggregator 5→3、gap secondary 2→1 に戻す。
// PR #51 で 3 閾値を同時に上げた結果、SE 由来の非技術ペインが pathway を全部塞がれて
// 配信 5/5 が技術系に偏った (2026-04-29 配信)。combinator は 3 のまま維持し、aggregator と
// gap secondary を緩めて SE 由来クラスタが drafter に届くようにする。
// drafter PASS 率の低さは scoring gate と devils_advocate で吸収する設計に戻す。
const AGGREGATOR_MIN_SIGNALS = 3;
const COMBINATOR_MIN_TOTAL_SIGNALS = 3;
// gap_candidates は angle 別に閾値を変える:
//   - launch_hn / show_hn: 1 件で OK (HN の 1 post 単独で需要検証済み事例として成立)
//   - その他: 1 件以上 (paid_service_mention / niche_transfer / other で SE の単発ペインを拾うため)
const GAP_MIN_SIGNALS_PRIMARY = 1; // launch_hn / show_hn
const GAP_MIN_SIGNALS_SECONDARY = 1; // paid_service_mention / niche_transfer / other
const GAP_PRIMARY_ANGLES: ReadonlySet<GapAngle> = new Set(['launch_hn', 'show_hn']);

function filterAggregator(
  bundles: LenientAggregatorBundle[],
  validIds: Set<string>,
): AggregatorBundle[] {
  const out: AggregatorBundle[] = [];
  for (const b of bundles) {
    const ids = b.signal_ids.filter((id) => validIds.has(id));
    // 重複除外
    const unique = Array.from(new Set(ids));
    if (unique.length < AGGREGATOR_MIN_SIGNALS) {
      console.warn(
        `[haiku] drop aggregator_bundle (valid_ids<${AGGREGATOR_MIN_SIGNALS} after filter): theme="${b.theme}"`,
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
    if (pain.length + info.length < COMBINATOR_MIN_TOTAL_SIGNALS) {
      console.warn(
        `[haiku] drop combinator_pair (pain+info<${COMBINATOR_MIN_TOTAL_SIGNALS} after filter): angle="${p.angle}" pain=${pain.length} info=${info.length}`,
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
    // Haiku が enum 外の angle を返した場合の正規化:
    //   1. 大小・前後空白を正規化して valid 集合に一致すればそのまま採用
    //   2. fuzzyMatchGapAngle で systematic な末尾ブレを補正 (show_h** → show_hn など)
    //   3. それ以外は "other" にフォールバック
    const normalized = g.angle.toLowerCase().trim();
    let angle: GapAngle;
    if (VALID_GAP_ANGLE_SET.has(normalized)) {
      angle = normalized as GapAngle;
    } else {
      angle = fuzzyMatchGapAngle(normalized) ?? 'other';
      console.warn(
        `[haiku] normalize gap_candidate.angle: "${g.angle}" → "${angle}" (hint="${g.hint}")`,
      );
    }
    // angle 別に最低件数を変える: launch_hn / show_hn は 1 件 OK、その他は 2 件以上
    const minRequired = GAP_PRIMARY_ANGLES.has(angle)
      ? GAP_MIN_SIGNALS_PRIMARY
      : GAP_MIN_SIGNALS_SECONDARY;
    if (ids.length < minRequired) {
      console.warn(
        `[haiku] drop gap_candidate (valid_ids<${minRequired} for angle=${angle} after filter): hint="${g.hint}"`,
      );
      continue;
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
