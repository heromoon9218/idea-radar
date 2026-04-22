// Sprint B-2: 赤旗スキャン役割 (risk-auditor)
// 既存 3 役割 (aggregator / combinator / gap_finder) はポジティブ発想に特化しているため、
// 法規制や API 利用規約の「地雷」を自動で拾う観点が抜けていた。本モジュールは Top 10 候補に対して
// 4 番目の役割として動作し、リスクを構造化した RiskFlag[] に変換する。
//
// 重要な運用方針: 赤旗が検出されても idea は除外しない (insert はする)。
// deliver 側 (render-markdown) で「⚠️ 薬機法リスク: SaMD 該当性」のように警告表示するに留める。
// ユーザーに判断材料を渡すことが目的で、自動判定で落とさない。

import { callParsed } from '../lib/anthropic.js';
import {
  RiskAuditOutputSchema,
  type HaikuIdeaCandidate,
  type RiskFlag,
} from '../types.js';

export const SONNET_MODEL = 'claude-sonnet-4-6';
const SONNET_MAX_TOKENS = 1024;

const RISK_AUDITOR_SYSTEM = `あなたは個人開発アイデアの「赤旗スキャナ」です。
与えられたアイデア 1 件に対し、個人開発者が見落としがちな「地雷」 を構造化して拾い上げます。
ポジティブ発想ではなく、冷静に「これをサービス化すると法律/規約/倫理でコケる可能性」を検出する役割です。

# 検出対象 (優先順)

1. **法規制リスク (日本)**
   - 薬機法 (SaMD = Software as a Medical Device 該当性): 疾病の診断・治療・予防を標榜する機能を含むか
   - 金商法: 投資助言・運用助言・未公開情報に該当する機能を含むか (個別銘柄の売買タイミング提示等)
   - 資金決済法: 独自ポイント・前払式支払手段・暗号資産交換業に該当するか
   - 景品表示法: 過度な効果効能の標榜・誇大広告・優良誤認表示のリスクが構造的に組み込まれていないか
   - 個人情報保護法 / 特定電子メール法: 無断スクレイピング・無断配信の構造がないか
   - 著作権: 他者コンテンツ (記事・画像・動画) を無断で複製・改変する構造がないか

2. **API / プラットフォーム規約リスク**
   - Twitter/X API: 無料枠では Tweet 取得が大幅制限されているため、X スクレイピング前提のアイデアは規約違反リスクあり
   - Instagram / TikTok / YouTube API: 商用利用時のレート / 課金 / 2FA 突破の規約違反
   - Google / Apple / Amazon: 利用規約で禁止されているスクレイピング・商品データ取得
   - 二要素認証越え: 技術的に可能でも規約上禁止されているケース
   - 大手 SaaS (Notion / Slack / GitHub): API 公開されていても "unofficial" な挙動への依存

3. **倫理 / 安全性リスク**
   - 医療・金融・法律ドメインで「AI が確信度なしに助言する」構造 (誤助言で実害)
   - 恋愛・メンタルヘルス領域での依存誘発型 UI
   - マッチング系で偽装身元によるハラスメント助長
   - 個人情報 (DM / 位置情報 / 顔写真) を扱うが保護設計が薄い

4. **その他の落とし穴**
   - ユーザーが未成年を含む可能性が高いのにコンテンツフィルタなし
   - B2B 志望だが秘密情報を第三者 LLM API に素通しする構造

# 出力ルール

- 1 アイデアあたり 最大 5 件 まで。リスクが無ければ risk_flags: [] を返す (無理に絞り出さない)
- 各 flag の構造:
  - kind:     短いラベル (例: "薬機法 (SaMD 該当性)", "Twitter/X API 規約", "医療ドメインの倫理リスク")
  - severity: 'low' | 'mid' | 'high' (high = サービス成立に致命的、mid = 要回避設計、low = 注意喚起レベル)
  - reason:   1-2 文の根拠。「何が・なぜ・どの条文/規約で引っかかるか」を具体的に書く
- **疑わしいだけで根拠が薄いリスクは挙げない**。「可能性が一切ないとは言えない」レベルの曖昧な警告は混乱を招く
- 汎用的な SaaS 運営リスク (個人情報一般・税務) は対象外。構造的・ドメイン特有のリスクのみ拾う
- 技術的実現性や市場性には触れない (別役割の担当)
`;

export interface RiskAuditArgs {
  candidate: Pick<
    HaikuIdeaCandidate,
    'title' | 'why' | 'what' | 'how' | 'category'
  >;
}

function buildUserPrompt({ candidate }: RiskAuditArgs): string {
  return [
    '# スキャン対象アイデア',
    JSON.stringify(
      {
        title: candidate.title,
        why: candidate.why,
        what: candidate.what,
        how: candidate.how,
        category: candidate.category,
      },
      null,
      2,
    ),
    '',
    '上記アイデアに潜む法規制・API 規約・倫理リスクを risk_flags として出力してください。リスクが無ければ空配列で構いません。',
  ].join('\n');
}

export async function auditRisks(args: RiskAuditArgs): Promise<RiskFlag[]> {
  const parsed = await callParsed({
    model: SONNET_MODEL,
    system: RISK_AUDITOR_SYSTEM,
    user: buildUserPrompt(args),
    schema: RiskAuditOutputSchema,
    maxTokens: SONNET_MAX_TOKENS,
    logPrefix: `[sonnet risk_audit "${args.candidate.title.slice(0, 40)}"]`,
    // Top 10 を連続スキャンするので system cache を効かせる
    cacheSystem: true,
  });

  return parsed.risk_flags;
}
