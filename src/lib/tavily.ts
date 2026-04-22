// Tavily Search API クライアント。無料枠 1,000 req/月。
// API ドキュメント: https://docs.tavily.com/api-reference/endpoint/search
// S2 の想定使用量は月 600 req (10 req/バッチ × 2 回/日 × 30 日) で無料枠内。
// Sprint B-4 で searchParallel を追加し、Top 10 × 3 クエリ = 月 900 req まで許容する設計。

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

// Sprint B-4: 複数クエリを並列に投げて結果を union する。
// 英語 1 本のみだと日本語市場の競合検出精度が弱いため、英語・日本語・機能語など
// 2-3 本の観点違いクエリを同時に投げ、URL で dedupe して Top N にまとめる。
//
// 戻り値:
//   - results: dedupe 後の上位ヒット (maxResults で切り詰め、score DESC)
//   - status:  'ok'     = 全クエリ成功かつ union 1 件以上
//              'empty'  = 全クエリ成功だが union 0 件
//              'failed' = 全クエリがネットワーク/HTTP エラーで失敗 (= 競合検証不能)
//   - queriesAttempted / queriesFailed: ログ観測用
//
// 1 本でも成功すれば 'ok' / 'empty' を返す (部分失敗はスコアラーに empty 扱いの抑制をさせない)。
// 全滅したときだけ 'failed' を返し、sonnet.ts 側で competition_score を最大 3 に制限する。
export interface ParallelSearchResult {
  results: TavilySearchResult[];
  status: 'ok' | 'empty' | 'failed';
  queriesAttempted: number;
  queriesFailed: number;
}

export async function searchParallel(
  queries: readonly string[],
  perQueryCount: number = 5,
  maxResults: number = 8,
  options: TavilySearchOptions = {},
): Promise<ParallelSearchResult> {
  const cleanQueries = queries
    .map((q) => q.trim())
    .filter((q) => q.length > 0);
  if (cleanQueries.length === 0) {
    return { results: [], status: 'empty', queriesAttempted: 0, queriesFailed: 0 };
  }

  const settled = await Promise.allSettled(
    cleanQueries.map((q) => tavilySearch(q, perQueryCount, options)),
  );

  const byUrl = new Map<string, TavilySearchResult>();
  let failed = 0;
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]!;
    const q = cleanQueries[i]!;
    if (s.status === 'rejected') {
      failed++;
      console.warn(
        `[tavily] parallel q="${q}" failed:`,
        s.reason instanceof Error ? s.reason.message : s.reason,
      );
      continue;
    }
    for (const hit of s.value) {
      const existing = byUrl.get(hit.url);
      // 同一 URL が複数クエリでヒットした場合は score が高い方を残す
      if (!existing || (hit.score ?? 0) > (existing.score ?? 0)) {
        byUrl.set(hit.url, hit);
      }
    }
  }

  const merged = Array.from(byUrl.values())
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, maxResults);

  const status: ParallelSearchResult['status'] =
    failed === cleanQueries.length
      ? 'failed'
      : merged.length === 0
        ? 'empty'
        : 'ok';

  return {
    results: merged,
    status,
    queriesAttempted: cleanQueries.length,
    queriesFailed: failed,
  };
}
