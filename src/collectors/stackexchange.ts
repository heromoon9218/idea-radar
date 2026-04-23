// Stack Exchange API 経由で非技術系の生活ペイン質問を収集する。
// 対象サイト: lifehacks / parenting / money (Personal Finance & Money)
//   - 非技術 SE サイトはいずれも「生活の困りごと」の純度が高く、
//     score / view_count / answer_count の定量メタで demand-summary が機能する。
//
// エンドポイント:
//   GET https://api.stackexchange.com/2.3/questions
//     ?site={site}&order=desc&sort=votes&pagesize=25
//     &fromdate={unix_seconds}&filter=withbody
//
// 設計メモ:
//   - sort=votes + fromdate=7日前: 過去 7 日以内に作成された質問のうち「投票が集まっている」
//     ものを優先。sinceMinutes は敢えて無視する (hatena コレクタと同じ設計)。
//     理由: 非技術 SE サイトは traffic が低く (lifehacks ~1-5q/day, parenting ~2-5q/day,
//     money ~10-30q/day)、24h 窓 + sort=votes では「投票が集まりきる前」の新着ばかりで
//     0 件近くなるため。7 日窓に広げることで demand-summary に値する score を持った質問を拾える。
//     dedup は raw_signals の UNIQUE(source, external_id) に任せる。
//   - filter=withbody: 質問本文を取得する。これを content に入れて Haiku に渡す。
//   - quota: 匿名 300 req/day/IP。本コレクタは 3 req/day なのでマージン大。
//
// external_id:
//   `{site}_{question_id}` 形式。SE 全体で question_id は site 内ユニークなので、
//   site を prefix に付けて横断ユニークにする。
//
// metadata:
//   - se_site:         サイト識別子 (lifehacks / parenting / money)
//                      → analyze.ts の toHaikuInputs で Haiku 入力にリフトされる (HN の story_type と同じ扱い)
//   - question_score:  投票スコア (負値もあり得る)
//   - view_count:      閲覧数 (demand-summary で痛み強度の proxy として使用)
//   - answer_count:    回答数
//   - is_answered:     ベストアンサーが付いているか
//   - tags:            タグ配列 (任意)

import { fetchWithRetry } from '../lib/fetch-retry.js';
import type { RawSignalInput } from '../types.js';

// 対象サイト。品質を見ながら cooking / workplace / diy / gardening / pets を追加可能。
const SITES: string[] = ['lifehacks', 'parenting', 'money'];

const PAGE_SIZE = 25;
// SE サイトは traffic が低く 24h では 0-1 件になるため、投票が集まるだけの時間幅で見る。
const LOOKBACK_DAYS = 7;
const USER_AGENT = 'idea-radar/0.1.0 (+https://github.com/Hiromu-Konomi/idea-radar)';
// 本文は長くなり得る (SE は回答付きで 3-5k chars)。Haiku のプロンプト肥大を避けるため
// content 側で切り詰める。1500 chars あれば痛みの輪郭は掴める。
const MAX_CONTENT_CHARS = 1500;

interface SEQuestion {
  question_id: number;
  title: string;
  body?: string;
  link: string;
  creation_date: number; // UNIX seconds
  score: number;
  view_count: number;
  answer_count: number;
  is_answered: boolean;
  tags?: string[];
  owner?: {
    display_name?: string;
  };
}

interface SEResponse {
  items?: SEQuestion[];
  quota_remaining?: number;
  error_id?: number;
  error_message?: string;
}

// SE body は HTML (段落タグ + コードブロック + リンク)。タグを雑に剥がして軽量化。
// エンティティは最低限のみデコードする。
function stripHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const withoutTags = html.replace(/<[^>]*>/g, ' ');
  const decoded = withoutTags
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
  if (decoded.length === 0) return null;
  return decoded.length > MAX_CONTENT_CHARS ? `${decoded.slice(0, MAX_CONTENT_CHARS)}…` : decoded;
}

// sinceMinutes は敢えて無視して LOOKBACK_DAYS 固定で取得する (冒頭コメント参照)。
// 呼び出し側 (collect.ts) との引数シグネチャ互換のために受け取るのみ。
export async function collectStackExchange(_sinceMinutes: number): Promise<RawSignalInput[]> {
  const fromdate = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 24 * 60 * 60;
  const results: RawSignalInput[] = [];

  for (const site of SITES) {
    const params = new URLSearchParams({
      site,
      order: 'desc',
      sort: 'votes',
      pagesize: String(PAGE_SIZE),
      fromdate: String(fromdate),
      filter: 'withbody',
    });
    const feedUrl = `https://api.stackexchange.com/2.3/questions?${params.toString()}`;
    try {
      const res = await fetchWithRetry(
        feedUrl,
        { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } },
        {
          onRetry: ({ attempt, error }) =>
            console.warn(
              `[stackexchange] site=${site} retry ${attempt}:`,
              error instanceof Error ? error.message : error,
            ),
        },
      );
      if (!res.ok) {
        console.error(`[stackexchange] site=${site} -> HTTP ${res.status}`);
        continue;
      }

      const body = (await res.json()) as SEResponse;
      if (body.error_id || body.error_message) {
        console.error(
          `[stackexchange] site=${site} API error ${body.error_id ?? ''}: ${body.error_message ?? ''}`,
        );
        continue;
      }
      const items = body.items ?? [];
      if (typeof body.quota_remaining === 'number') {
        console.log(
          `[stackexchange] site=${site} fetched=${items.length} quota_remaining=${body.quota_remaining}`,
        );
      }

      for (const q of items) {
        if (!q.question_id || !q.title || !q.link || !q.creation_date) continue;
        if (q.creation_date < fromdate) continue;

        const postedAt = new Date(q.creation_date * 1000);
        if (isNaN(postedAt.getTime())) continue;

        const externalId = `${site}_${q.question_id}`;

        results.push({
          source: 'stackexchange',
          external_id: externalId,
          url: q.link,
          title: q.title,
          content: stripHtml(q.body),
          author: q.owner?.display_name ?? null,
          posted_at: postedAt.toISOString(),
          metadata: {
            se_site: site,
            question_score: q.score,
            view_count: q.view_count,
            answer_count: q.answer_count,
            is_answered: q.is_answered,
            tags: q.tags ?? [],
          },
        });
      }
    } catch (err) {
      console.error(`[stackexchange] site=${site} failed:`, err);
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
