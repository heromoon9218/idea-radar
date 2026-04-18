import { fetchWithRetry } from '../lib/fetch-retry.js';
import type { HnStoryType, RawSignalInput } from '../types.js';

const BASE = 'https://hacker-news.firebaseio.com/v0';
// HN の新規投稿は 1h あたり 40〜100 件なので、370 分ウィンドウをカバーするには最大 600 件超。
// 余裕を持って 1500 まで拾う。早期脱出ロジック (oldestInBatch < sinceSec) があるので、
// 実コストは通常走行時ほぼ変わらない。
const MAX_IDS = 1500;
const CONCURRENCY = 10;

const HN_TITLE_PREFIX_RE = /^\s*(show|ask|launch|tell)\s+hn\s*:/i;

export function classifyHnTitle(title: string): HnStoryType {
  const m = HN_TITLE_PREFIX_RE.exec(title);
  if (!m || !m[1]) return 'normal';
  return m[1].toLowerCase() as HnStoryType;
}

export interface CollectHackerNewsOptions {
  // 指定した story_type のみ収集する。未指定なら全件（タグ付けのみ）。
  storyTypes?: HnStoryType[];
}

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
    // 個別 item は 1 回リトライで十分（1500 件取りに行くため過剰リトライはコスト高）
    const res = await fetchWithRetry(`${BASE}/item/${id}.json`, undefined, { retries: 1 });
    if (!res.ok) return null;
    return (await res.json()) as HNItem | null;
  } catch {
    return null;
  }
}

export async function collectHackerNews(
  sinceMinutes: number,
  options: CollectHackerNewsOptions = {},
): Promise<RawSignalInput[]> {
  const sinceSec = Math.floor(Date.now() / 1000) - sinceMinutes * 60;
  const typeFilter = options.storyTypes ? new Set(options.storyTypes) : null;

  const idsRes = await fetchWithRetry(`${BASE}/newstories.json`, undefined, {
    onRetry: ({ attempt, error }) =>
      console.warn(
        `[hn] newstories retry ${attempt}:`,
        error instanceof Error ? error.message : error,
      ),
  });
  if (!idsRes.ok) {
    throw new Error(`[hn] newstories HTTP ${idsRes.status}`);
  }
  const allIds = (await idsRes.json()) as number[];
  const targetIds = allIds.slice(0, MAX_IDS);

  const results: RawSignalInput[] = [];
  const typeCounts: Record<HnStoryType, number> = {
    show: 0,
    ask: 0,
    launch: 0,
    tell: 0,
    normal: 0,
  };
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

      const storyType = classifyHnTitle(item.title);
      if (typeFilter && !typeFilter.has(storyType)) continue;
      typeCounts[storyType] += 1;

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
          story_type: storyType,
        },
      });
    }

    if (oldestInBatch < sinceSec) break;
  }

  console.log(
    `[hn] story_type breakdown show=${typeCounts.show} ask=${typeCounts.ask} launch=${typeCounts.launch} tell=${typeCounts.tell} normal=${typeCounts.normal}`,
  );

  return results;
}
