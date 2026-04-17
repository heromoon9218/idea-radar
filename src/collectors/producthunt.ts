import type { RawSignalInput } from '../types.js';

const ENDPOINT = 'https://api.producthunt.com/v2/api/graphql';

const QUERY = `
  query RecentPosts($first: Int!) {
    posts(first: $first, order: NEWEST) {
      edges {
        node {
          id
          slug
          name
          tagline
          description
          url
          createdAt
          votesCount
          commentsCount
          user { username name }
          topics(first: 5) { edges { node { name } } }
        }
      }
    }
  }
`;

interface PHTopicNode {
  name?: string;
}

interface PHPostNode {
  id: string;
  slug: string;
  name: string;
  tagline?: string;
  description?: string;
  url: string;
  createdAt: string;
  votesCount?: number;
  commentsCount?: number;
  user?: { username?: string; name?: string };
  topics?: { edges: Array<{ node: PHTopicNode }> };
}

interface PHResponse {
  data?: {
    posts?: {
      edges: Array<{ node: PHPostNode }>;
    };
  };
  errors?: Array<{ message: string }>;
}

export async function collectProductHunt(sinceMinutes: number): Promise<RawSignalInput[]> {
  const token = process.env.PRODUCTHUNT_TOKEN;
  if (!token) {
    throw new Error('PRODUCTHUNT_TOKEN is required');
  }
  const sinceMs = Date.now() - sinceMinutes * 60 * 1000;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'idea-radar/0.1.0',
    },
    body: JSON.stringify({ query: QUERY, variables: { first: 30 } }),
  });

  if (!res.ok) {
    throw new Error(`[producthunt] HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as PHResponse;
  if (json.errors?.length) {
    throw new Error(`[producthunt] GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  const results: RawSignalInput[] = [];
  for (const edge of json.data?.posts?.edges ?? []) {
    const n = edge.node;
    if (!n.createdAt) continue;
    const postedAt = new Date(n.createdAt);
    if (isNaN(postedAt.getTime())) continue;
    if (postedAt.getTime() < sinceMs) continue;

    const parts = [n.tagline, n.description].filter((v): v is string => Boolean(v));

    results.push({
      source: 'producthunt',
      external_id: String(n.id),
      url: n.url || `https://www.producthunt.com/posts/${n.slug}`,
      title: n.name,
      content: parts.join('\n\n') || null,
      author: n.user?.username ?? n.user?.name ?? null,
      posted_at: postedAt.toISOString(),
      metadata: {
        votes: n.votesCount ?? null,
        comments: n.commentsCount ?? null,
        topics: (n.topics?.edges ?? [])
          .map((te) => te.node.name)
          .filter((v): v is string => Boolean(v)),
      },
    });
  }

  return results;
}
