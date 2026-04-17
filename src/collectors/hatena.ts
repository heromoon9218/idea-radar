import { XMLParser } from 'fast-xml-parser';
import { fetchWithRetry } from '../lib/fetch-retry.js';
import type { RawSignalInput } from '../types.js';

const FEEDS: { url: string; category: string }[] = [
  { url: 'https://b.hatena.ne.jp/hotentry/it.rss', category: 'hotentry-it' },
  { url: 'https://b.hatena.ne.jp/entrylist/it.rss', category: 'entrylist-it' },
];

interface HatenaItem {
  link?: string;
  title?: string;
  description?: string;
  'dc:date'?: string;
  'dc:creator'?: string;
  'dc:subject'?: string | string[];
  'hatena:bookmarkcount'?: number | string;
  '@_rdf:about'?: string;
}

// fast-xml-parser のデフォルト entity expansion limit (1000) に引っかかるため
// processEntities: false で受けて、必要な値だけ手動デコードする。
function decodeEntities(input: string): string {
  return input
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&amp;/gi, '&');
}

function str(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return decodeEntities(value);
  if (typeof value === 'number') return String(value);
  return null;
}

// 注意: 他コレクタは `sinceMinutes` で時間窓フィルタをかけるが、はてなブックマークの
// Hotentry / entrylist の `dc:date` は「記事投稿時刻」であって「hotentry 入り時刻」ではないため、
// 収集ウィンドウ（数時間〜半日）でフィルタすると恒常的に 0 件になる。このコレクタは RSS の全件を返し、
// DB の UNIQUE(source, external_id) + `ignoreDuplicates` で自然に新規分だけが蓄積される設計。
// 引数は API 互換のため残す。
export async function collectHatena(_sinceMinutes: number): Promise<RawSignalInput[]> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    processEntities: false,
  });
  const results: RawSignalInput[] = [];

  for (const feed of FEEDS) {
    try {
      const res = await fetchWithRetry(
        feed.url,
        { headers: { 'User-Agent': 'idea-radar/0.1.0' } },
        {
          onRetry: ({ attempt, error }) =>
            console.warn(
              `[hatena] ${feed.url} retry ${attempt}:`,
              error instanceof Error ? error.message : error,
            ),
        },
      );
      if (!res.ok) {
        console.error(`[hatena] ${feed.url} -> HTTP ${res.status}`);
        continue;
      }
      const xml = await res.text();
      const parsed = parser.parse(xml);
      const rawItems = parsed?.['rdf:RDF']?.item ?? [];
      const items: HatenaItem[] = Array.isArray(rawItems) ? rawItems : [rawItems];

      for (const item of items) {
        const link = str(item.link) ?? str(item['@_rdf:about']);
        const title = str(item.title);
        const date = str(item['dc:date']);
        if (!link || !title || !date) continue;

        const postedAt = new Date(date);
        if (isNaN(postedAt.getTime())) continue;

        const subjects = item['dc:subject'];
        const tags = Array.isArray(subjects)
          ? subjects.map((s) => str(s)).filter((s): s is string => Boolean(s))
          : subjects
            ? [str(subjects)].filter((s): s is string => Boolean(s))
            : [];

        results.push({
          source: 'hatena',
          external_id: link,
          url: link,
          title,
          content: str(item.description),
          author: str(item['dc:creator']),
          posted_at: postedAt.toISOString(),
          metadata: {
            category: feed.category,
            bookmark_count: item['hatena:bookmarkcount'] ?? null,
            tags,
          },
        });
      }
    } catch (err) {
      console.error(`[hatena] ${feed.url} failed:`, err);
    }
  }

  return dedupByExternalId(results);
}

function dedupByExternalId(items: RawSignalInput[]): RawSignalInput[] {
  const seen = new Set<string>();
  const out: RawSignalInput[] = [];
  for (const item of items) {
    if (seen.has(item.external_id)) continue;
    seen.add(item.external_id);
    out.push(item);
  }
  return out;
}
