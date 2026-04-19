// Sonnet で Haiku 候補を 3 軸 (market / tech / competition) 1-5 でスコアリングし、
// 渡した Web 検索結果 (Tavily) から競合を抽出・整形する。1 呼び出し / 候補で Top 10 分。

import { callParsed } from '../lib/anthropic.js';
import type { TavilySearchResult } from '../lib/tavily.js';
import {
  SonnetScoredIdeaSchema,
  type HaikuIdeaCandidate,
  type SonnetScoredIdea,
} from '../types.js';

export const SONNET_MODEL = 'claude-sonnet-4-6';
const SONNET_MAX_TOKENS = 2048;

const SONNET_SYSTEM = `あなたは個人開発アイデアの審査官です。
Haiku が抽出した候補アイデアを 3 軸で厳格にスコアリングします。

スコアリング軸 (各 1-5 の整数):
- market_score: 潜在ユーザー数・支払意欲。5 = 個人開発者や中小開発チームの日常的なニーズで、月 $5〜20 なら払う層が見える。1 = ほぼ誰も必要としない。
- tech_score: 技術難度の低さ。5 = 既存 API 組み合わせで週末 MVP。3 = 1-3 ヶ月で MVP。1 = 研究課題レベルの難度で個人開発不向き。
- competition_score: 競合の少なさ・差別化のしやすさ。5 = ほぼ競合不在。3 = 類似サービス 1-2 個。1 = レッドオーシャン。

必須動作:
- 与えられる検索結果は競合候補です。類似サービスと明確に判断できるものだけを 0〜3 件 competitors に整形 (name は英日いずれかの表記、url は見つかれば含める、note は特徴の要約 1 文)
- 検索結果が空でも他 2 軸はスコアリングし、competitors は [] で返す
- 個人開発者の実在性を冷静に評価し、甘い採点は避ける
- pain_summary / idea_description / title は Haiku 候補をベースに、必要に応じて個人開発者向けに簡潔化してよい
- source_signal_ids は Haiku 候補の配列をそのまま維持すること`;

interface BuildArgs {
  candidate: HaikuIdeaCandidate;
  searchResults: TavilySearchResult[];
}

function buildUserPrompt({ candidate, searchResults }: BuildArgs): string {
  return [
    '# Haiku が抽出したアイデア候補',
    JSON.stringify(
      {
        title: candidate.title,
        pain_summary: candidate.pain_summary,
        idea_description: candidate.idea_description,
        category: candidate.category,
        source_signal_ids: candidate.source_signal_ids,
      },
      null,
      2,
    ),
    '',
    '# Web 検索結果 (top 5)',
    searchResults.length === 0
      ? '(検索結果は空です。competitors は [] として scoring を続けてください)'
      : JSON.stringify(searchResults, null, 2),
    '',
    '上記を踏まえて 3 軸スコアと competitors を出力してください。',
  ].join('\n');
}

export async function scoreIdea(
  candidate: HaikuIdeaCandidate,
  searchResults: TavilySearchResult[],
): Promise<SonnetScoredIdea> {
  const parsed = await callParsed({
    model: SONNET_MODEL,
    system: SONNET_SYSTEM,
    user: buildUserPrompt({ candidate, searchResults }),
    schema: SonnetScoredIdeaSchema,
    maxTokens: SONNET_MAX_TOKENS,
    logPrefix: `[sonnet score "${candidate.title.slice(0, 40)}"]`,
    // 同 system で Top 10 を連続スコアリングするので cache を効かせる
    cacheSystem: true,
  });

  // LLM が source_signal_ids を勝手に削ることがあるため、Haiku 側の ID を信頼して上書き
  return { ...parsed, source_signal_ids: candidate.source_signal_ids };
}
