// Reddit の公開 Atom feed (.rss) を subreddit 単位で叩いて収集する。
// URL 形式: https://www.reddit.com/r/{sub}/top.rss?t=day&limit=25
//
// なぜ JSON (/top.json) ではなく RSS か:
//   Reddit は 2024 年以降、匿名での /top.json へのアクセスを段階的に強め、
//   GitHub Actions の IP 帯からは UA を付けても 403 で恒常ブロックされる。
//   一方 .rss (Atom feed) は同じコンテンツを匿名・UA 必須で配信し続けており、
//   個人開発スケールでは安定して取得できる。score / num_comments のような
//   数値シグナルは RSS では取れないので犠牲にするが、subreddit + タイトル +
//   本文プレビューは拾えるので analyze 段階の痛み抽出には十分。
//
// sinceMinutes の扱い:
//   Atom entry の <published> を JS Date でパースし時間窓フィルタを適用する
//   (Zenn / note と同じ挙動)。

import { XMLParser } from 'fast-xml-parser';
import { fetchWithRetry } from '../lib/fetch-retry.js';
import type { RawSignalInput } from '../types.js';

const SUBREDDITS: string[] = [
  'sidehustle',      // 副業ワーカーの愚痴・ツール要望
  'Etsy',            // ハンドメイド EC セラーの痛み
  'youtubers',       // YouTuber の運営・集客・編集の痛み
  'selfimprovement', // 自己管理層 (習慣化・集中) の継続的な課題
  'Entrepreneur',    // 個人寄り起業家の投稿 (r/smallbusiness より軽量)
];

const LIMIT_PER_SUB = 25;
const USER_AGENT = 'idea-radar/0.1.0 (personal idea discovery bot)';

interface AtomLink {
  '@_href'?: string;
  '@_rel'?: string;
}

interface AtomAuthor {
  name?: string;
  uri?: string;
}

interface AtomEntry {
  id?: string;
  title?: string | { '#text'?: string };
  link?: AtomLink | AtomLink[];
  author?: AtomAuthor;
  published?: string;
  updated?: string;
  content?: string | { '#text'?: string };
  category?: { '@_term'?: string } | Array<{ '@_term'?: string }>;
}

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
  if (typeof value === 'object' && value !== null && '#text' in value) {
    const t = (value as { '#text'?: unknown })['#text'];
    if (typeof t === 'string') return decodeEntities(t);
  }
  return null;
}

// Atom の <link> は単数または配列。rel="alternate" を優先、無ければ最初の href。
function pickAlternateHref(link: AtomEntry['link']): string | null {
  if (!link) return null;
  const links = Array.isArray(link) ? link : [link];
  const alt = links.find((l) => l['@_rel'] === 'alternate' || l['@_rel'] == null);
  const chosen = alt ?? links[0];
  return chosen?.['@_href'] ?? null;
}

// Reddit Atom の <id> は "t3_xxxxx" 形式で返る。念のため tag: 形式にも対応。
function normalizeExternalId(atomId: string | null, fallbackUrl: string): string {
  if (!atomId) return fallbackUrl;
  const trimmed = atomId.trim();
  const match = /t3_[a-z0-9]+/i.exec(trimmed);
  if (match) return match[0];
  return trimmed;
}

// content は `<![CDATA[...]]>` or エンティティエスケープされた HTML。
// LLM には title で十分なので、content からはタグを雑に剥がして軽量化する。
function stripHtml(html: string | null): string | null {
  if (!html) return null;
  const withoutTags = html.replace(/<[^>]*>/g, ' ');
  const cleaned = withoutTags.replace(/\s+/g, ' ').trim();
  return cleaned.length === 0 ? null : cleaned;
}

export async function collectReddit(sinceMinutes: number): Promise<RawSignalInput[]> {
  const sinceMs = Date.now() - sinceMinutes * 60 * 1000;
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    processEntities: false,
  });

  const results: RawSignalInput[] = [];

  for (const sub of SUBREDDITS) {
    const feedUrl = `https://www.reddit.com/r/${encodeURIComponent(sub)}/top.rss?t=day&limit=${LIMIT_PER_SUB}`;
    try {
      const res = await fetchWithRetry(
        feedUrl,
        { headers: { 'User-Agent': USER_AGENT, Accept: 'application/atom+xml' } },
        {
          onRetry: ({ attempt, error }) =>
            console.warn(
              `[reddit] r/${sub} retry ${attempt}:`,
              error instanceof Error ? error.message : error,
            ),
        },
      );
      if (!res.ok) {
        console.error(`[reddit] r/${sub} -> HTTP ${res.status}`);
        continue;
      }

      const xml = await res.text();
      const parsed = parser.parse(xml);
      const rawEntries = parsed?.feed?.entry ?? [];
      const entries: AtomEntry[] = Array.isArray(rawEntries) ? rawEntries : [rawEntries];

      for (const entry of entries) {
        const title = str(entry.title);
        const href = pickAlternateHref(entry.link);
        const publishedStr = str(entry.published) ?? str(entry.updated);
        if (!title || !href || !publishedStr) continue;

        const postedAt = new Date(publishedStr);
        if (isNaN(postedAt.getTime())) continue;
        if (postedAt.getTime() < sinceMs) continue;

        const externalId = normalizeExternalId(str(entry.id), href);
        const author = entry.author?.name ?? null;
        const content = stripHtml(str(entry.content));

        results.push({
          source: 'reddit',
          external_id: externalId,
          url: href,
          title,
          content,
          author,
          posted_at: postedAt.toISOString(),
          metadata: {
            subreddit: sub,
          },
        });
      }
    } catch (err) {
      console.error(`[reddit] r/${sub} failed:`, err);
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
