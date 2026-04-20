// note.com のハッシュタグ別 RSS (RSS 2.0) を複数束ねて収集する。
// URL 形式: https://note.com/hashtag/{タグ}/rss (公式サポート)
//
// タグ選定の方針:
//   軽量ドメイン (個人開発で PLG で届く層) の痛みを拾うタグを選ぶ。
//   「副業」は note 上でギャンブル予想・アフィリエイト記事の温床のため除外。
//   具体的な経営課題・運営ノウハウ・失敗談が出るタグを優先。
//
// sinceMinutes の扱い:
//   RSS の pubDate は記事公開時刻なので、Zenn と同じく時間窓フィルタを適用する。

import { XMLParser } from 'fast-xml-parser';
import { fetchWithRetry } from '../lib/fetch-retry.js';
import type { RawSignalInput } from '../types.js';

// 軽量ドメインに対応するタグ群。実運用で品質を見ながら増減する。
// URI エンコードして URL に差し込むため、ここでは生の日本語で持つ。
const HASHTAGS: string[] = [
  'YouTube', // YouTuber / 配信者の運営ノウハウ・悩み
  '動画編集', // 動画編集者 (副業ワーカー) の痛み
  'ハンドメイド', // minne / Creema セラーの痛み
  '投資', // 個人投資家の振り返り・ツール要望
  'ブログ運営', // ブロガーの集客・収益化の痛み
];

interface NoteRssItem {
  link?: string;
  title?: string;
  description?: string;
  pubDate?: string;
  'dc:creator'?: string;
  category?: string | string[];
  guid?: string | { '#text'?: string };
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

export async function collectNote(sinceMinutes: number): Promise<RawSignalInput[]> {
  const sinceMs = Date.now() - sinceMinutes * 60 * 1000;
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    processEntities: false,
  });

  const results: RawSignalInput[] = [];

  for (const tag of HASHTAGS) {
    const feedUrl = `https://note.com/hashtag/${encodeURIComponent(tag)}/rss`;
    try {
      const res = await fetchWithRetry(
        feedUrl,
        { headers: { 'User-Agent': 'idea-radar/0.1.0' } },
        {
          onRetry: ({ attempt, error }) =>
            console.warn(
              `[note] tag="${tag}" retry ${attempt}:`,
              error instanceof Error ? error.message : error,
            ),
        },
      );
      if (!res.ok) {
        console.error(`[note] tag="${tag}" -> HTTP ${res.status}`);
        continue;
      }
      const xml = await res.text();
      const parsed = parser.parse(xml);
      const rawItems = parsed?.rss?.channel?.item ?? [];
      const items: NoteRssItem[] = Array.isArray(rawItems) ? rawItems : [rawItems];

      for (const item of items) {
        const link = str(item.link);
        const title = str(item.title);
        const pubDateStr = str(item.pubDate);
        if (!link || !title || !pubDateStr) continue;

        const postedAt = new Date(pubDateStr);
        if (isNaN(postedAt.getTime())) continue;
        if (postedAt.getTime() < sinceMs) continue;

        // note の RSS の link は https://note.com/{user}/n/{slug} 形式。これを external_id に流用。
        // 同一記事が複数タグ RSS に跨って出現するため、呼び出し側 dedup を信頼する。
        const guid = typeof item.guid === 'string' ? item.guid : str(item.guid);
        const externalId = guid ?? link;

        const categories = Array.isArray(item.category)
          ? item.category.map((c) => str(c)).filter((c): c is string => Boolean(c))
          : item.category
            ? [str(item.category)].filter((c): c is string => Boolean(c))
            : [];

        results.push({
          source: 'note',
          external_id: externalId,
          url: link,
          title,
          content: str(item.description),
          author: str(item['dc:creator']),
          posted_at: postedAt.toISOString(),
          metadata: {
            hashtag: tag,
            categories,
          },
        });
      }
    } catch (err) {
      console.error(`[note] tag="${tag}" failed:`, err);
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
