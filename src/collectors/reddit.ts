// Reddit の公開 JSON エンドポイントから軽量ドメイン向けの subreddit を束ねて収集する。
// URL 形式: https://www.reddit.com/r/{sub}/top.json?t=day&limit=25
//
// 認証:
//   認証なしで叩ける公開エンドポイント。ただし Reddit は匿名アクセスに
//   User-Agent を厳しく要求するため、識別可能な UA を必ず付ける
//   (付けないと 429/403 で弾かれることがある)。
//
// subreddit 選定の方針:
//   軽量ドメインの英語圏版 (クリエイター / 副業ワーカー / 個人 EC / 自己管理 / 個人寄り起業家)
//   を狙う。r/smallbusiness は重い (商談・従業員管理の話が多い) ため除外し、
//   PLG で届く層の生の痛みが出る sub を優先。
//
// sinceMinutes の扱い:
//   Reddit 投稿時刻 created_utc は秒単位。Zenn と同じく時間窓フィルタを適用する。

import { z } from 'zod';
import { fetchWithRetry } from '../lib/fetch-retry.js';
import type { RawSignalInput } from '../types.js';

const SUBREDDITS: string[] = [
  'sidehustle', // 副業ワーカーの愚痴・ツール要望
  'Etsy', // ハンドメイド EC セラーの痛み
  'youtubers', // YouTuber の運営・集客・編集の痛み
  'selfimprovement', // 自己管理層 (習慣化・集中) の継続的な課題
  'Entrepreneur', // 個人寄り起業家の投稿 (r/smallbusiness より軽量)
];

const LIMIT_PER_SUB = 25;
const USER_AGENT = 'idea-radar/0.1.0 (personal idea discovery bot)';

// Reddit JSON の top エンドポイント応答の必要最小限のスキーマ。
// 想定外フィールドは z.object.passthrough() で落とさず無視する。
const RedditPostDataSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    selftext: z.string().optional().nullable(),
    author: z.string().optional().nullable(),
    created_utc: z.number(),
    permalink: z.string().min(1),
    url: z.string().optional().nullable(),
    score: z.number().optional().nullable(),
    num_comments: z.number().optional().nullable(),
    subreddit: z.string().min(1),
    over_18: z.boolean().optional().nullable(),
    stickied: z.boolean().optional().nullable(),
    is_self: z.boolean().optional().nullable(),
  })
  .passthrough();

const RedditListingSchema = z
  .object({
    data: z.object({
      children: z.array(z.object({ data: RedditPostDataSchema.passthrough() })),
    }),
  })
  .passthrough();

export async function collectReddit(sinceMinutes: number): Promise<RawSignalInput[]> {
  const sinceSec = Math.floor(Date.now() / 1000) - sinceMinutes * 60;
  const results: RawSignalInput[] = [];

  for (const sub of SUBREDDITS) {
    const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/top.json?t=day&limit=${LIMIT_PER_SUB}`;
    try {
      const res = await fetchWithRetry(
        url,
        { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } },
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

      const json = (await res.json()) as unknown;
      const parsed = RedditListingSchema.safeParse(json);
      if (!parsed.success) {
        console.warn(`[reddit] r/${sub} invalid listing: ${parsed.error.message}`);
        continue;
      }

      for (const { data } of parsed.data.data.children) {
        if (data.stickied) continue; // 固定投稿 (告知・ルール) は除外
        if (data.over_18) continue; // 念のため NSFW は除外
        if (data.created_utc < sinceSec) continue;

        const postUrl = `https://www.reddit.com${data.permalink}`;
        // 外部 URL (is_self=false) の場合は本文がリンク先にある。selftext は空なので
        // LLM 用コンテンツとして title+selftext を結合する。
        const content = (data.selftext ?? '').trim() || null;

        results.push({
          source: 'reddit',
          external_id: `t3_${data.id}`,
          url: postUrl,
          title: data.title,
          content,
          author: data.author ?? null,
          posted_at: new Date(data.created_utc * 1000).toISOString(),
          metadata: {
            subreddit: data.subreddit,
            score: data.score ?? null,
            num_comments: data.num_comments ?? null,
            external_url: data.url ?? null,
            is_self: data.is_self ?? null,
          },
        });
      }
    } catch (err) {
      console.error(`[reddit] r/${sub} failed:`, err);
    }
  }

  return results;
}
