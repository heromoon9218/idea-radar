import type { RawSignalInput } from '../types.js';

const SUBS = ['programming', 'webdev', 'SaaS', 'SideProject', 'startups'];

interface RedditTokenRes {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface RedditChildData {
  id: string;
  title: string;
  selftext?: string;
  author?: string;
  permalink: string;
  subreddit?: string;
  score?: number;
  num_comments?: number;
  link_flair_text?: string | null;
  url_overridden_by_dest?: string | null;
  created_utc: number;
}

interface RedditListingRes {
  data?: {
    children: Array<{ data: RedditChildData }>;
  };
}

async function getAccessToken(userAgent: string): Promise<string> {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET is required');
  }
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    throw new Error(`[reddit] token HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as RedditTokenRes;
  return json.access_token;
}

export async function collectReddit(sinceMinutes: number): Promise<RawSignalInput[]> {
  const userAgent = process.env.REDDIT_USER_AGENT || 'idea-radar/0.1.0';
  const token = await getAccessToken(userAgent);
  const sinceSec = Math.floor(Date.now() / 1000) - sinceMinutes * 60;

  const results: RawSignalInput[] = [];
  for (const sub of SUBS) {
    try {
      const res = await fetch(`https://oauth.reddit.com/r/${sub}/new?limit=50`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': userAgent,
        },
      });
      if (!res.ok) {
        console.error(`[reddit] r/${sub} HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json()) as RedditListingRes;
      const children = json.data?.children ?? [];

      for (const c of children) {
        const d = c.data;
        if (!d || d.created_utc < sinceSec) continue;

        results.push({
          source: 'reddit',
          external_id: d.id,
          url: `https://www.reddit.com${d.permalink}`,
          title: d.title,
          content: d.selftext ?? null,
          author: d.author ?? null,
          posted_at: new Date(d.created_utc * 1000).toISOString(),
          metadata: {
            subreddit: d.subreddit,
            score: d.score,
            num_comments: d.num_comments,
            link_flair_text: d.link_flair_text ?? null,
            external_url: d.url_overridden_by_dest ?? null,
          },
        });
      }
    } catch (err) {
      console.error(`[reddit] r/${sub} failed:`, err);
    }
  }

  return results;
}
