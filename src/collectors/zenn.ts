import { fetchWithRetry } from '../lib/fetch-retry.js';
import type { RawSignalInput } from '../types.js';

// Stack Exchange を主要ソースに据えた際に、技術系のバイアス低減のため 100 → 30 に圧縮。
// Zenn は新着の大半が score (liked_count) 0-1 で埋もれる短文 / 自己紹介 / 日報記事が多く、
// 上位 30 件に絞っても demand-summary の裏取り精度は損なわれにくい。
const API = 'https://zenn.dev/api/articles?order=latest&count=30';

interface ZennArticle {
  id: number;
  post_type: string;
  title: string;
  slug: string;
  comments_count: number;
  liked_count: number;
  bookmarked_count: number;
  body_letters_count: number;
  article_type: string;
  emoji: string;
  path: string;
  published_at: string;
  topics?: Array<{ name?: string; display_name?: string }>;
  user?: { username?: string; name?: string };
}

interface ZennResponse {
  articles: ZennArticle[];
}

export async function collectZenn(sinceMinutes: number): Promise<RawSignalInput[]> {
  const sinceMs = Date.now() - sinceMinutes * 60 * 1000;

  const res = await fetchWithRetry(
    API,
    { headers: { 'User-Agent': 'idea-radar/0.1.0' } },
    {
      onRetry: ({ attempt, error }) =>
        console.warn(`[zenn] retry ${attempt}:`, error instanceof Error ? error.message : error),
    },
  );
  if (!res.ok) {
    throw new Error(`[zenn] HTTP ${res.status}`);
  }
  const json = (await res.json()) as ZennResponse;

  const results: RawSignalInput[] = [];
  for (const a of json.articles ?? []) {
    if (!a.published_at) continue;
    const postedAt = new Date(a.published_at);
    if (isNaN(postedAt.getTime())) continue;
    if (postedAt.getTime() < sinceMs) continue;

    results.push({
      source: 'zenn',
      external_id: String(a.id),
      url: `https://zenn.dev${a.path}`,
      title: a.title,
      // Zenn API は本文・要約を返さないため null。emoji / title の複製は S2 の LLM 入力を
      // 汚染するだけなので持たない。emoji は metadata 側に残す。
      content: null,
      author: a.user?.username ?? null,
      posted_at: postedAt.toISOString(),
      metadata: {
        emoji: a.emoji ?? null,
        topics: (a.topics ?? []).map((t) => t.display_name ?? t.name).filter(Boolean),
        liked_count: a.liked_count,
        comments_count: a.comments_count,
        bookmarked_count: a.bookmarked_count,
        article_type: a.article_type,
        body_letters_count: a.body_letters_count,
      },
    });
  }

  return results;
}
