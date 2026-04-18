// Tavily Search API クライアント。無料枠 1,000 req/月。
// API ドキュメント: https://docs.tavily.com/api-reference/endpoint/search
// S2 の想定使用量は月 600 req (10 req/バッチ × 2 回/日 × 30 日) で無料枠内。

import { fetchWithRetry } from './fetch-retry.js';

const ENDPOINT = 'https://api.tavily.com/search';

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

interface TavilyApiResponse {
  query?: string;
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
  }>;
}

export interface TavilySearchOptions {
  // 検索精度。basic = 1 credit, advanced = 2 credit。S2 の競合検索は basic で十分。
  searchDepth?: 'basic' | 'advanced' | 'fast' | 'ultra-fast';
  topic?: 'general' | 'news' | 'finance';
}

export async function tavilySearch(
  query: string,
  count: number = 5,
  options: TavilySearchOptions = {},
): Promise<TavilySearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY is required');
  }

  const body = {
    query,
    max_results: count,
    search_depth: options.searchDepth ?? 'basic',
    topic: options.topic ?? 'general',
    include_answer: false,
    include_raw_content: false,
  };

  const res = await fetchWithRetry(
    ENDPOINT,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'idea-radar/0.1.0',
      },
      body: JSON.stringify(body),
    },
    {
      // 無料 1000 req 枠を守るため過剰リトライは避ける
      retries: 1,
      onRetry: ({ attempt, error }) =>
        console.warn(
          `[tavily] retry ${attempt}:`,
          error instanceof Error ? error.message : error,
        ),
    },
  );

  if (!res.ok) {
    // 401 (auth) / 429 (rate) / 4xx は呼び出し側で catch してスキップする
    throw new Error(`[tavily] HTTP ${res.status} for q="${query}"`);
  }

  const json = (await res.json()) as TavilyApiResponse;
  const raw = json.results ?? [];

  const results: TavilySearchResult[] = [];
  for (const r of raw) {
    if (!r.title || !r.url) continue;
    results.push({
      title: r.title,
      url: r.url,
      content: r.content ?? '',
      score: r.score,
    });
  }
  return results;
}
