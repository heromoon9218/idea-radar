import type { RawSignalInput } from '../types.js';

const BASE = 'https://hacker-news.firebaseio.com/v0';
// HN の新規投稿は 1h あたり 40〜100 件なので、370 分ウィンドウをカバーするには最大 600 件超。
// 余裕を持って 1500 まで拾う。早期脱出ロジック (oldestInBatch < sinceSec) があるので、
// 実コストは通常走行時ほぼ変わらない。
const MAX_IDS = 1500;
const CONCURRENCY = 10;

interface HNItem {
  id: number;
  type?: string;
  by?: string;
  time?: number;
  title?: string;
  text?: string;
  url?: string;
  score?: number;
  descendants?: number;
  dead?: boolean;
  deleted?: boolean;
}

async function fetchItem(id: number): Promise<HNItem | null> {
  try {
    const res = await fetch(`${BASE}/item/${id}.json`);
    if (!res.ok) return null;
    return (await res.json()) as HNItem | null;
  } catch {
    return null;
  }
}

export async function collectHackerNews(sinceMinutes: number): Promise<RawSignalInput[]> {
  const sinceSec = Math.floor(Date.now() / 1000) - sinceMinutes * 60;

  const idsRes = await fetch(`${BASE}/newstories.json`);
  if (!idsRes.ok) {
    throw new Error(`[hn] newstories HTTP ${idsRes.status}`);
  }
  const allIds = (await idsRes.json()) as number[];
  const targetIds = allIds.slice(0, MAX_IDS);

  const results: RawSignalInput[] = [];
  for (let i = 0; i < targetIds.length; i += CONCURRENCY) {
    const batch = targetIds.slice(i, i + CONCURRENCY);
    const items = await Promise.all(batch.map(fetchItem));
    let oldestInBatch = Infinity;

    for (const item of items) {
      if (!item || item.dead || item.deleted) continue;
      if (item.type !== 'story') continue;
      if (!item.title || !item.time) continue;
      if (item.time < oldestInBatch) oldestInBatch = item.time;
      if (item.time < sinceSec) continue;

      results.push({
        source: 'hackernews',
        external_id: String(item.id),
        url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
        title: item.title,
        content: item.text ?? null,
        author: item.by ?? null,
        posted_at: new Date(item.time * 1000).toISOString(),
        metadata: {
          score: item.score ?? null,
          descendants: item.descendants ?? null,
          hn_url: `https://news.ycombinator.com/item?id=${item.id}`,
        },
      });
    }

    if (oldestInBatch < sinceSec) break;
  }

  return results;
}
