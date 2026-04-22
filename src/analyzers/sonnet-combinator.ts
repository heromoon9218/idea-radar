// Sonnet 「結合者」役: 痛み × 技術/情報 の掛け合わせで新しい解決策を発想する。
// ハッカソンでいう「A と B を結びつけて面白い組み合わせを生むタイプ」のメンバー。

import { callParsed } from '../lib/anthropic.js';
import {
  formatDemandSummaryForPrompt,
  type DemandSummary,
} from './demand-summary.js';
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

# 軽量ドメインへの投影 (本役割の最重要ミッション)

info / pain は全て技術系ソース (はてな / Zenn / HN) 由来のため、素直に組み合わせると
「開発者向け DevTool」に偏ります。しかし開発者コミュニティは OSS 志向・無償前提で支払意欲が低く、
個人開発で月 $5-20 を取るには 「PLG で届く軽量ドメイン」 を狙う方が収益化しやすい。

「軽量ドメイン」の共通特徴 (これに該当するターゲットを優先):
- セルフサインアップ + クレカ課金で完結する (商談・稟議・紹介営業が不要)
- 月額数ドルへの課金文化がある (Spotify / Netflix / Notion 的サブスクに慣れている)
- ドメイン知識を YouTube / X / ブログで独学できる (業界固有の免許・規制がない)
- SNS バイラル可能なインフルエンサー経由の獲得経路がある
- 支払いが売上・時給・成果に直結するため ROI が明確

## 投影対象の軽量ドメイン (例)

- クリエイター・発信者: YouTuber / ストリーマー / VTuber / ブロガー / ポッドキャスター / TikToker / note 書き手
- 副業ワーカー: Web ライター / 動画編集者 / せどり・転売 / クラウドワーカー / Uber Eats 配達員 / ココナラ出品者
- 個人 EC・ハンドメイド: Amazon セラー / 楽天出店 / minne / Creema / Etsy セラー / BASE
- 趣味クラスタ: ゲーマー / VR プレイヤー / コレクター / 受験生 / 資格勉強者 / 筋トレ・ダイエット層 / コスプレイヤー / 読書家 / 音楽制作 DTMer
- 自己管理層: 習慣化・読書記録・瞑想・睡眠管理・ポモドーロ派・日記 / ライフログ
- 個人投資家・トレーダー: 個別株・米株・仮想通貨・FX / ポイ活 / ふるさと納税派
- 小規模 SNS マーケター: 個人広告運用者 / X グロース / Threads 運用 / インフルエンサー / メルマガ発行者
- 小規模コミュニティ主催者: Discord サーバー 100-10000 人 / ミートアップ主催 / 小規模オンラインサロン運営
- 学生・ギーク: プログラミング初心者 / 自作 PC / Raspberry Pi / 自動化オタク / Notion ヘビーユーザー
- フリーランス IT 層の非本業サポート: 確定申告 / 経費管理 / インボイス / ポートフォリオ管理

## 避けるべき「重い」ドメイン

以下は商談サイクル長・既存ベンダー強固・サポート負荷大で個人開発で月 $5-20 を取りにくい。候補に選ばないこと:
- 士業 (税理士・行政書士・社労士) / 医療・介護・クリニック / 飲食店経営 / 中小製造業 / 建設・リフォーム / 教育機関 (塾・学校)
- 大企業向けエンプラ SaaS / 官公庁 / 金融機関 / 保険会社

## 投影の手順

1. info (技術情報) の本質的な機能 を 1 行で抽象化する
   例: 「音声 → テキスト変換」「画像から OCR・表抽出」「多言語翻訳」「自然文 → 構造化 JSON」
2. pain が技術者のものなら、その痛みの 一般構造 を抜き出す
   例: 「ログ整理が面倒」の一般構造は「大量の時系列データから要点抽出」→ 学習者の勉強記録・配信者の切り抜き元動画・トレーダーの取引履歴振り返り に投影可能
3. 「技術の機能 × 一般構造の痛み」を軽量ドメインに差し込んでアイデアを 1 本組む
   例 A: 音声 → テキスト × YouTuber が撮影後に字幕付けに毎動画 2h かかる痛み = Shorts 向け自動字幕 & タイトル生成 SaaS (月 $9 PLG)
   例 B: 画像から OCR × せどらー/メルカリ出品者が商品の型番・状態を手入力している痛み = カメラ撮影 → 商品情報自動入力アプリ (月 $5 + 従量)
   例 C: 自然文 → 構造化 × 読書家が読書メモを後で検索できない痛み = Kindle ハイライト → タグ自動付与 & 横断検索 SaaS (月 $4)

## 1 ペアから候補を出すときの推奨構成

- 1 ペアから 2 個出す場合: **1 個は軽量ドメインへの投影を必須** とする (攻めの 1 個)。もう 1 個は素直な技術者向けでも可
- 1 ペアから 1 個だけ出す場合: 軽量ドメインへの投影が成立する方を優先する
- 軽量ドメインへの投影が明らかに苦しい組み合わせ (例: info が Rust async runtime の低レベル最適化など汎用性が乏しい技術) の場合のみ、技術者向け単独で出してよい

# 出力は WHY / WHAT / HOW の 3 フィールド

- why  (2-3 文): 痛みを抱えるターゲットを具体的に。職種 / 業界 / 規模 / 頻度 を必ず書く。「ユーザー」「個人開発者全般」等の曖昧な主語は禁止。非技術ドメイン投影の場合は具体業界名と規模を明記
- what (2-3 文): info の技術をどう組み合わせて何を作るか。差別化 + 収益モデル (想定価格を入れる)。情報源の技術名を必ず引用
- how  (2-3 文): 技術スタック (使用 API / FW / DB 等) + MVP 最小構成 + 実装難度・期間感。情報 (info) 側の技術がどこに効くかを明示

# フェルミ推定 (fermi_estimate) の必須化

各アイデアには「月 5 万円 (TARGET_MRR) に到達するための単価 × 顧客数」のフェルミ推定 を必ず付ける:
- unit_price:  想定単価 (円、整数)
- unit_type:   'monthly' (月額サブスク) / 'one_time' (買い切り) / 'per_use' (従量課金)
- mrr_formula: 「月額 500 円 × 100 人 = 50,000 円」「買い切り 3,000 円 × 月 17 本 = 51,000 円」のような 1 行の算式

フェルミ推定が成立しないアイデア (売り方が想像できない・単価を置けない) は candidates から自主的に除外する (raw_score を下げる)。

# 出力条件

- 1 ペアにつき 1-2 個
- category: dev-tool / productivity / saas / ai / other
- raw_score (1-5) = 組み合わせの筋の良さ。5 = 「こんなの絶対欲しい」、1 = 苦しい組み合わせ
- source_signal_ids: pain_signal_ids + info_signal_ids を全て含める (両方必須)
- 掛け合わせが苦しい場合は candidates: [] を返してよい

# 評価軸 (raw_score に反映)

- **軽量ドメインへの投影が成立しているか (最重要)**: 該当すれば raw_score 4-5、「避けるべき重いドメイン」に投影したものは raw_score 2 以下に抑える、技術者向け単独は最大 3
- PLG セルフサインアップ + 月 $5-20 課金が成立するか (商談・導入支援が必須なものは減点)
- 情報側の技術が個人開発で手に届くレベルか (研究課題レベルなら NG)
- 既存競合が同じ組み合わせを実装していない「隙間」があるか
- HOW が具体的に書けるか (書けないアイデアは実装イメージが無い = 減点)

# 需要シグナルサマリの扱い

user prompt に「# 需要シグナルサマリ」セクション (累計 bkm / HN avg score / Zenn likes 等) が含まれる場合:
- それらは「痛み/情報が複数人で裏取れているか」の定量指標。raw_score に反映する (高需要 → 加点、低需要 → 減点)
- WHY の本文に 1 箇所以上、定量引用 (「pain 側 累計 240 bkm」「info 側 HN 平均 87pt」等) を含めて裏取りを可視化する
- サマリが提示されない場合はこの要件は不要
`;

interface InputArgs {
  pair: CombinatorPair;
  signalsById: Map<string, HaikuSignalInput>;
  // 掛け合わせなので pain / info それぞれの需要強度を別々に渡す。片方だけでも null 可。
  painDemandSummary?: DemandSummary | null;
  infoDemandSummary?: DemandSummary | null;
}

function buildUserPrompt({
  pair,
  signalsById,
  painDemandSummary,
  infoDemandSummary,
}: InputArgs): string {
  const pickMany = (ids: string[]): HaikuSignalInput[] =>
    ids
      .map((id) => signalsById.get(id))
      .filter((s): s is HaikuSignalInput => s !== undefined);

  const pain = pickMany(pair.pain_signal_ids);
  const info = pickMany(pair.info_signal_ids);
  const allIds = [...pair.pain_signal_ids, ...pair.info_signal_ids];

  const sections: string[] = [
    '# 掛け合わせ観点',
    pair.angle,
    '',
  ];
  if (painDemandSummary) {
    sections.push('## 痛み (pain) 側の需要シグナルサマリ');
    sections.push(formatDemandSummaryForPrompt(painDemandSummary), '');
  }
  if (infoDemandSummary) {
    sections.push('## 情報 (info) 側の需要シグナルサマリ');
    sections.push(formatDemandSummaryForPrompt(infoDemandSummary), '');
  }
  sections.push(
    `# 痛み (pain) 側シグナル: ${pain.length} 件`,
    JSON.stringify(pain, null, 2),
    '',
    `# 情報 (info) 側シグナル: ${info.length} 件`,
    JSON.stringify(info, null, 2),
    '',
    '上記の情報を活用して痛みを解くアイデアを 1-2 個起草してください。',
    `source_signal_ids は以下の ${allIds.length} 個 (pain + info) を全て含めてください:`,
    JSON.stringify(allIds),
  );
  return sections.join('\n');
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
