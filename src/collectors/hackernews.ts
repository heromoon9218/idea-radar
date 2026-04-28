import { fetchWithRetry } from '../lib/fetch-retry.js';
import type { HnStoryType, RawSignalInput } from '../types.js';

const BASE = 'https://hacker-news.firebaseio.com/v0';
// HN の新規投稿は 1h あたり 40〜100 件なので、370 分ウィンドウをカバーするには最大 600 件超。
// 余裕を持って 1500 まで拾う。早期脱出ロジック (oldestInBatch < sinceSec) があるので、
// 実コストは通常走行時ほぼ変わらない。
const MAX_IDS = 1500;
const CONCURRENCY = 10;

// 表記揺れに寛容化 (2026-04-29):
//   - 旧: `\s+hn\s*:`  → `Show HN:` 専用 (空白必須・コロン必須)
//   - 新: `\s*hn\s*[:：—\-–]` → `ShowHN:` / `Show HN — ` / `Show HN - ` / `Show HN：` (全角コロン) も許容
// セパレータは半角コロン / 全角コロン / em dash / hyphen / en dash の 5 種を受ける。
// 過去 3 日 launch_hn が 0 件だった件への対策の一環 (実際は HN 上に Launch HN 投稿は出ているはず)。
const HN_TITLE_PREFIX_RE = /^\s*(show|ask|launch|tell)\s*hn\s*[:：—\-–]/i;

export function classifyHnTitle(title: string): HnStoryType {
  const m = HN_TITLE_PREFIX_RE.exec(title);
  if (!m || !m[1]) return 'normal';
  return m[1].toLowerCase() as HnStoryType;
}

export interface CollectHackerNewsOptions {
  // 指定した story_type のみ収集する。未指定なら全件（タグ付けのみ）。
  storyTypes?: HnStoryType[];
  // normal (Show/Ask/Launch/Tell HN プリフィックスを持たない通常投稿) は
  // 量が多くノイズ比が高いので、HN score 上位 N 件のみ採用する。
  // show / ask / launch / tell は本数が少なく質も高いので常に全件保持する。
  // 未指定なら全件保持 (旧挙動互換)。
  normalTopByScore?: number;
  // 2026-04-29 追加: score 上位 N 件から外れた normal でも、タイトル/本文に支払意欲を示す
  // キーワード (pay for / willing to pay / subscribe / I'd pay $ など) がマッチすれば追加で救済する。
  // 値はその救済件数の上限。0 もしくは未指定なら救済しない (旧挙動互換)。
  // 救済された signal には metadata.payment_intent: true が付与される。
  normalSalvageByPaymentIntent?: number;
  // 2026-04-29 追加: 指定した story_type の post について、HN API の kids から
  // トップコメントを最大 N 件取得し metadata.top_comments に格納する。
  // show_hn の post 本文は外部 URL のみで空のことが多いが、コメントには
  // 「これも欲しい」「これじゃ足りない」「Y はどう?」といった隣接ペインが大量にあるので、
  // Haiku のクラスタリング材料として有効。
  // ask_hn / launch_hn にも適用すると痛み詳細やローンチ反応を拾える。
  fetchTopCommentsFor?: HnStoryType[];
  // fetchTopCommentsFor が指定されたときの 1 post あたりの comment 取得上限 (デフォルト 5)。
  topCommentsLimit?: number;
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
  // 2026-04-29 追加: HN API の item endpoint は子コメント ID 配列を返す。
  // 投稿順 (上位は古い) なので、上位 N 件取得 = 最も票が集まった上位の議論スレッドではない点に注意。
  // 経験的には Top スレッド = 上位 N 件のうち comment スコアが高いもの、というほどに偏らない。
  kids?: number[];
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

// 支払意欲を示すキーワード (HN normal の救済用)。
// HN は英語コミュニティなので英語で書く。"pay for" / "I'd pay" / "willing to pay" /
// "subscribe" / "subscription" / "monthly fee" / "pricing" / "happy to pay" を網羅する。
// 偽陽性 ("subscribe to RSS" など) は許容 (Haiku 側で痛みクラスタリング時に弾かれる)。
const PAYMENT_INTENT_RE =
  /\b(pay\s+for|i'?d\s+pay|i\s+would\s+pay|willing\s+to\s+pay|happy\s+to\s+pay|pay\s+\$|paying\s+customers?|subscription|monthly\s+(fee|subscription)|pricing\s+(model|page|tier))\b/i;

function hasPaymentIntent(title: string, content: string | null): boolean {
  return PAYMENT_INTENT_RE.test(`${title} ${content ?? ''}`);
}

// HN comment の text は HTML なので雑に剥がして軽量化。
// 1 comment 500 chars に切り詰める (Haiku への入力肥大を抑える)。
const COMMENT_MAX_CHARS = 500;
function stripCommentHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// HN API の kids を辿ってトップコメントを取得。
// kids は score 順ではなく投稿順 (古い順) だが、HN の慣習として上位 5 件はおおよそ
// 議論の中心スレッドを代表する。完璧ではないが軽量取得でコスト/精度バランスが取れる。
async function fetchTopComments(item: HNItem, maxComments: number): Promise<string[]> {
  if (!item.kids || item.kids.length === 0 || maxComments <= 0) return [];
  const targetKids = item.kids.slice(0, maxComments);
  const settled = await Promise.all(targetKids.map((id) => fetchItem(id)));
  const out: string[] = [];
  for (const c of settled) {
    if (!c || c.dead || c.deleted) continue;
    if (c.type !== 'comment') continue;
    if (!c.text) continue;
    const stripped = stripCommentHtml(c.text);
    if (stripped.length === 0) continue;
    out.push(stripped.length > COMMENT_MAX_CHARS ? `${stripped.slice(0, COMMENT_MAX_CHARS)}…` : stripped);
  }
  return out;
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

  // 2026-04-29: 指定 story_type の post に対して kids 経由でトップコメント取得を行う
  // ためのオプション解決。Set にしておくと後段の判定が O(1) で済む。
  const fetchCommentsTypes = options.fetchTopCommentsFor
    ? new Set<HnStoryType>(options.fetchTopCommentsFor)
    : null;
  const topCommentsLimit = options.topCommentsLimit ?? 5;

  // post item と story_type を一旦 pending に貯める。
  // top_comments の取得が必要な post は、post 列挙ループとは別に並列取得する
  // (ループ内で逐次取得すると HN API が複数バッチで 200-300 req 増えてレートを圧迫するため)。
  interface PendingPost {
    item: HNItem;
    storyType: HnStoryType;
  }
  const pending: PendingPost[] = [];
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

      pending.push({ item, storyType });
    }

    if (oldestInBatch < sinceSec) break;
  }

  // top_comments 取得。show_hn / ask_hn / launch_hn のみ (50-70 件/日 程度) を想定。
  // kids 1 post につき N=5 コメント並列取得 → post 並列度 5 で全体を流す。
  // worst case 70 post × 5 comment = 350 req 追加 (元の post 取得 1500 req に対して 23%)。
  const commentsByPostId = new Map<number, string[]>();
  if (fetchCommentsTypes && fetchCommentsTypes.size > 0) {
    const targetPosts = pending.filter((p) => fetchCommentsTypes.has(p.storyType));
    const POST_CONCURRENCY = 5;
    for (let i = 0; i < targetPosts.length; i += POST_CONCURRENCY) {
      const batch = targetPosts.slice(i, i + POST_CONCURRENCY);
      const fetched = await Promise.all(
        batch.map(async (p) => ({
          id: p.item.id,
          comments: await fetchTopComments(p.item, topCommentsLimit),
        })),
      );
      for (const f of fetched) {
        if (f.comments.length > 0) commentsByPostId.set(f.id, f.comments);
      }
    }
    console.log(
      `[hn] top_comments fetched for ${commentsByPostId.size}/${targetPosts.length} posts (types=${[...fetchCommentsTypes].join(',')}, limit=${topCommentsLimit})`,
    );
  }

  // pending → results 変換。top_comments があれば metadata に追加。
  const results: RawSignalInput[] = pending.map(({ item, storyType }) => {
    const baseMetadata: Record<string, unknown> = {
      score: item.score ?? null,
      descendants: item.descendants ?? null,
      hn_url: `https://news.ycombinator.com/item?id=${item.id}`,
      story_type: storyType,
    };
    const topComments = commentsByPostId.get(item.id);
    if (topComments && topComments.length > 0) {
      baseMetadata.top_comments = topComments;
    }
    return {
      source: 'hackernews',
      external_id: String(item.id),
      url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
      title: item.title!,
      content: item.text ?? null,
      author: item.by ?? null,
      posted_at: new Date(item.time! * 1000).toISOString(),
      metadata: baseMetadata,
    };
  });

  console.log(
    `[hn] story_type breakdown show=${typeCounts.show} ask=${typeCounts.ask} launch=${typeCounts.launch} tell=${typeCounts.tell} normal=${typeCounts.normal}`,
  );

  // normal を score 上位 N 件に絞る + 支払意欲キーワード救済 (オプション指定時のみ)。
  // HN の normal は 24h で 400+ 件発生することがあり、そのほとんどは score 1-2 で埋もれる。
  // score は newstories 列挙時点のスナップショットなので、当日朝に収集するジョブでは
  // 「既に浮上した記事 = score 高」が良い痛みシグナルの proxy になる。
  //
  // 2026-04-29 救済追加: score 上位から外れた normal でも、タイトル/本文に
  // PAYMENT_INTENT_RE がマッチすれば追加で救済する。score は伸びてないが
  // 「I'd pay $X for...」のような支払文化シグナルを取りこぼさないため。
  if (options.normalTopByScore !== undefined && typeCounts.normal > options.normalTopByScore) {
    const limit = options.normalTopByScore;
    const salvageLimit = options.normalSalvageByPaymentIntent ?? 0;
    const isNormal = (r: RawSignalInput): boolean =>
      (r.metadata as { story_type?: HnStoryType } | null)?.story_type === 'normal';
    const nonNormals = results.filter((r) => !isNormal(r));
    const sortedByScore = results
      .filter(isNormal)
      .sort((a, b) => {
        const sa = (a.metadata as { score?: number | null } | null)?.score ?? 0;
        const sb = (b.metadata as { score?: number | null } | null)?.score ?? 0;
        return sb - sa;
      });
    const topNormals = sortedByScore.slice(0, limit);
    const topIds = new Set(topNormals.map((r) => r.external_id));

    let salvaged: RawSignalInput[] = [];
    if (salvageLimit > 0) {
      salvaged = sortedByScore
        .filter((r) => !topIds.has(r.external_id) && hasPaymentIntent(r.title, r.content ?? null))
        .slice(0, salvageLimit)
        .map((r) => ({
          ...r,
          // 救済された signal には metadata.payment_intent: true を立てる。
          // 後段の Haiku/drafter で「支払意欲が明示されたシグナル」として優先化に使える。
          metadata: { ...(r.metadata ?? {}), payment_intent: true },
        }));
    }

    const droppedNormals = typeCounts.normal - topNormals.length - salvaged.length;
    console.log(
      `[hn] normal filter: kept top ${topNormals.length}/${typeCounts.normal} by score, salvaged ${salvaged.length} by payment intent (dropped ${droppedNormals})`,
    );
    return [...nonNormals, ...topNormals, ...salvaged];
  }

  return results;
}
