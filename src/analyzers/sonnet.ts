// Sonnet で Haiku 候補を 3 軸 (market / tech / competition) 1-5 でスコアリングし、
// 渡した Web 検索結果 (Tavily) から競合を抽出・整形する。1 呼び出し / 候補で Top 10 分。

import { callParsed } from '../lib/anthropic.js';
import type { GoalBand } from '../lib/goal-band.js';
import type { TavilySearchResult } from '../lib/tavily.js';
import {
  SonnetScoredIdeaSchema,
  type HaikuIdeaCandidate,
  type SonnetScoredIdea,
} from '../types.js';

export const SONNET_MODEL = 'claude-sonnet-4-6';
const SONNET_MAX_TOKENS = 2048;

// Tavily 検索の状態。competition_score の採点抑制ルールで使う。
// - ok     : 検索が成功し 1 件以上返ってきた (通常)
// - empty  : 検索は成功したが 0 件 (競合ゼロ or 検索語が弱かったかは区別不能)
// - failed : ネットワーク / 認証 / レート制限などで検索自体が失敗
export type TavilyStatus = 'ok' | 'empty' | 'failed';

const SONNET_SYSTEM_BASE = `あなたは個人開発アイデアの審査官です。
Haiku + 3 役割 Sonnet が起草した候補アイデアを 3 軸で厳格にスコアリングします。

スコアリング軸 (各 1-5 の整数):
- market_score: 潜在ユーザー数・支払意欲。5 = 個人開発者や中小開発チームの日常的なニーズで、月 $5〜20 なら払う層が見える。1 = ほぼ誰も必要としない。
- tech_score: 技術難度の低さ。5 = 既存 API 組み合わせで週末 MVP。3 = 1-3 ヶ月で MVP。1 = 研究課題レベルの難度で個人開発不向き。
- competition_score: 競合の少なさ・差別化のしやすさ。5 = ほぼ競合不在。3 = 類似サービス 1-2 個。1 = レッドオーシャン。

必須動作:
- 与えられる検索結果は競合候補です。類似サービスと明確に判断できるものだけを 0〜3 件 competitors に整形 (name は英日いずれかの表記、url は見つかれば含める、note は特徴の要約 1 文)
- 検索結果が空でも他 2 軸はスコアリングし、competitors は [] で返す
- 「検索状態」が empty または failed の場合、競合状況を網羅的に検証できていないため competition_score は最大 3 に制限する (検索で拾えなかっただけの可能性があり、競合不在とは断定できない)
- 個人開発者の実在性を冷静に評価し、甘い採点は避ける
- why / what / how / title は候補をベースに、必要に応じて個人開発者向けに簡潔化してよい。ただし 3 フィールドとも必ず埋めること (空文字禁止)
  - why  = 誰のどんな痛みか (ターゲット + 状況)
  - what = 何を作るか + 差別化 + 収益モデル
  - how  = 技術スタック + MVP 構成 + 実装難度
- how が候補側で薄い場合でも、market/tech の採点根拠から逆算して埋め直してよい
- source_signal_ids は候補の配列をそのまま維持すること`;

// 帯ごとの rubric 補足。scoreIdea 呼び出し時に BASE と連結して system prompt を作る。
// 1 バッチ内では帯が一定なので cacheSystem: true でも prompt は同一 → キャッシュヒットする。
function bandGuidance(band: GoalBand, targetMrr: number): string {
  if (band === 'niche-deep') {
    return `
# ゴール帯: niche-deep (月収目標 ${targetMrr.toLocaleString('en-US')} 円以下)
このユーザーは少数の熱狂的コアユーザーを狙う個人開発者です。帯固有の追加判断基準:
- market_score: 「大勢」ではなく「10〜50 人のコアユーザーに月額 500〜2000 円を払ってもらえるニッチ」があるなら 5。mass market 向けは 3 止まり
- competition_score: 5 = 完全にニッチ領域で競合なし、3 = 周辺領域に類似サービス。競合が厚くても自分のニッチに踏み込んでこないなら加点してよい`;
  }
  if (band === 'growth-channel') {
    return `
# ゴール帯: growth-channel (月収目標 ${targetMrr.toLocaleString('en-US')} 円前後)
このユーザーは 100 人規模の有料ユーザーを PLG / B2B 小口で獲得する個人開発者です。帯固有の追加判断基準:
- market_score: 「支払文化がある層 × 明確なセルフサインアップ導線」が描けるなら 5。B2C で無料志向が強い層は 3 止まり
- competition_score: 半年〜1 年後に後追い競合が出てきても堀れるかを重視。単純機能差別化は 3 止まり、データ / コミュニティ / 統合の堀が見えるなら 4 以上`;
  }
  // moat
  return `
# ゴール帯: moat (月収目標 ${targetMrr.toLocaleString('en-US')} 円以上)
このユーザーは持続的な参入障壁を求めるフェーズです。帯固有の追加判断基準:
- market_score: 大規模 TAM で需要が堅い領域を 5 とする
- competition_score: データネットワーク効果 / スイッチングコスト / 規制障壁を伴う堀の有無で評価。単純な先行者利益は 3 止まり`;
}

function buildSonnetSystem(band: GoalBand, targetMrr: number): string {
  return `${SONNET_SYSTEM_BASE}\n${bandGuidance(band, targetMrr)}`;
}

interface BuildArgs {
  candidate: HaikuIdeaCandidate;
  searchResults: TavilySearchResult[];
  status: TavilyStatus;
}

function describeStatus(status: TavilyStatus, hitCount: number): string {
  if (status === 'ok') return `検索成功 (hits=${hitCount})`;
  if (status === 'empty')
    return '検索結果 0 件 (競合が本当に無いのか検索で拾えなかったのかは不明 — competition_score は最大 3 に制限)';
  return '検索失敗 (API エラー等で競合検証ができていない — competition_score は最大 3 に制限)';
}

function buildUserPrompt({ candidate, searchResults, status }: BuildArgs): string {
  return [
    '# 起草されたアイデア候補',
    JSON.stringify(
      {
        title: candidate.title,
        why: candidate.why,
        what: candidate.what,
        how: candidate.how,
        category: candidate.category,
        source_signal_ids: candidate.source_signal_ids,
      },
      null,
      2,
    ),
    '',
    '# 検索状態',
    describeStatus(status, searchResults.length),
    '',
    '# Web 検索結果 (top 5)',
    searchResults.length === 0
      ? '(検索結果は空です。competitors は [] として scoring を続けてください)'
      : JSON.stringify(searchResults, null, 2),
    '',
    '上記を踏まえて 3 軸スコアと competitors を出力してください。',
  ].join('\n');
}

export interface ScoreIdeaOptions {
  band: GoalBand;
  targetMrr: number;
}

export async function scoreIdea(
  candidate: HaikuIdeaCandidate,
  searchResults: TavilySearchResult[],
  status: TavilyStatus,
  { band, targetMrr }: ScoreIdeaOptions,
): Promise<SonnetScoredIdea> {
  const parsed = await callParsed({
    model: SONNET_MODEL,
    system: buildSonnetSystem(band, targetMrr),
    user: buildUserPrompt({ candidate, searchResults, status }),
    schema: SonnetScoredIdeaSchema,
    maxTokens: SONNET_MAX_TOKENS,
    logPrefix: `[sonnet score "${candidate.title.slice(0, 40)}"]`,
    // 同 system で Top 10 を連続スコアリングするので cache を効かせる (band は 1 バッチ内固定)
    cacheSystem: true,
  });

  // LLM が source_signal_ids を勝手に削ることがあるため、Haiku 側の ID を信頼して上書き
  return { ...parsed, source_signal_ids: candidate.source_signal_ids };
}
