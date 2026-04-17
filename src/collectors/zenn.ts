import type { RawSignalInput } from '../types.js';

const API = 'https://zenn.dev/api/articles?order=latest&count=100';

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

  const res = await fetch(API, {
    headers: { 'User-Agent': 'idea-radar/0.1.0' },
  });
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
      content: `${a.emoji ?? ''} ${a.title}`.trim(),
      author: a.user?.username ?? null,
      posted_at: postedAt.toISOString(),
      metadata: {
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
