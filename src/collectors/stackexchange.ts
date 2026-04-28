// Stack Exchange API 経由で非技術系の生活ペイン + 支払文化のあるニッチペインを収集する。
// 本ツールの**主要ソース**。技術系 3 ソース (はてブ / Zenn / HN) の「自作できる・無料志向」バイアスを
// 緩和するため複数サイトに拡張して主要ソースに据えている (3 サイトから拡張時の経緯は git log 参照)。
//
// 対象サイト (14):
//   parenting / money / workplace / cooking / diy / travel / pets / gardening / fitness /
//   law / outdoors / expatriates / freelancing / pm
//
// 2026-04-29 入替: 雑談寄り・支払意欲弱の 3 サイト (lifehacks / interpersonal / academia) を削除し、
//   支払文化が強い 2 サイト (freelancing / pm) に差し替え (差し引き -1 で 14 サイト)。
//   - lifehacks: 雑多な生活ハック、ツール購買意欲が薄い
//   - interpersonal: 個人感情の悩みが中心、SaaS 化が遠い
//   - academia: 大学経費依存で個人開発 SaaS の支払者にならない
//   - freelancing: 請求・契約・税務の実務痛み (個人事業主は道具にお金を払う層)
//   - pm: プロジェクト管理 (PM はツール導入決裁権あり、B2B 小口の主戦場)
//   ※ Personal Productivity SE は SE Network から廃止されているため採用不可
//      (smoke 実行時に site=productivity が HTTP 400 を返した、2026-04-29 確認)。
//
// エンドポイント:
//   GET https://api.stackexchange.com/2.3/questions
//     ?site={site}&order=desc&sort={month|hot}&pagesize=50&filter=withbody
//
// 2 種類のクエリを並走させる:
//   - sort=month: 過去 30 日で最も投票された質問 (需要が裏取れた classic pain)
//   - sort=hot:   今まさに活動が集中している質問 (fresh pain / trending)
//   両方 dedup した上で union。classic と fresh の両面で SE のペインをカバー。
//
// quota:
//   匿名 300 req/day/IP。15 site × 2 query = 30 req/day で 10% 消費。安全マージン大。
//
// external_id:
//   `{site}_{question_id}` 形式。SE 全体で question_id は site 内ユニークなので、
//   site を prefix に付けて横断ユニークにする。
//
// sinceMinutes の扱い:
//   敢えて無視する (hatena コレクタと同じ設計)。sort=month/hot は API 側で時間窓が組み込まれており、
//   dedup は raw_signals の UNIQUE(source, external_id) に任せる。
//   SE サイトの中には traffic が非常に低いもの (freelancing / fitness / expatriates 等) があり、
//   24h 窓では 0-1 件になってしまうため。
//
// metadata:
//   - se_site:         サイト識別子 (analyze.ts の toHaikuInputs で Haiku 入力にリフトされる)
//   - question_score:  投票スコア (負値もあり得る)
//   - view_count:      閲覧数 (demand-summary の痛み強度 proxy)
//   - answer_count:    回答数
//   - is_answered:     ベストアンサーが付いているか
//   - tags:            タグ配列

import { fetchWithRetry } from '../lib/fetch-retry.js';
import type { RawSignalInput } from '../types.js';

// 対象サイト 14 個。カテゴリバランス (2026-04-29 入替後):
//   生活全般: diy / cooking / gardening / outdoors
//   家族: parenting / pets
//   金・仕事・規制: money / workplace / law
//   身体・ライフスタイル: fitness / travel / expatriates
//   支払文化系 (新規): freelancing / pm
//
// 削除したサイト: lifehacks (雑談) / interpersonal (個人感情) / academia (大学経費依存)。
// productivity は SE Network 廃止済みのため採用不可。
// 削除理由は本ファイル冒頭の「2026-04-29 入替」コメント参照。
const SITES: string[] = [
  'parenting',
  'money',
  'workplace',
  'cooking',
  'diy',
  'travel',
  'pets',
  'gardening',
  'fitness',
  'law',
  'outdoors',
  'expatriates',
  'freelancing',
  'pm',
];

// 2 種類のクエリを並走させる。sort=month = 過去 30 日最高スコア、sort=hot = 今活動中。
// union + dedup で classic pain と fresh pain の両面を網羅する。
const SORTS: readonly ('month' | 'hot')[] = ['month', 'hot'] as const;

const PAGE_SIZE = 50;
const USER_AGENT = 'idea-radar/0.1.0 (+https://github.com/Hiromu-Konomi/idea-radar)';
// 本文は長くなり得る (SE は質問本文だけでも 3-5k chars)。Haiku のプロンプト肥大を避けるため
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

// 1 (site, sort) 組を取得。失敗は呼び出し側で捕捉。
async function fetchOne(
  site: string,
  sort: 'month' | 'hot',
): Promise<{ items: SEQuestion[]; quotaRemaining: number | null }> {
  const params = new URLSearchParams({
    site,
    order: 'desc',
    sort,
    pagesize: String(PAGE_SIZE),
    filter: 'withbody',
  });
  const feedUrl = `https://api.stackexchange.com/2.3/questions?${params.toString()}`;
  const res = await fetchWithRetry(
    feedUrl,
    { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } },
    {
      onRetry: ({ attempt, error }) =>
        console.warn(
          `[stackexchange] site=${site} sort=${sort} retry ${attempt}:`,
          error instanceof Error ? error.message : error,
        ),
    },
  );
  if (!res.ok) {
    console.error(`[stackexchange] site=${site} sort=${sort} -> HTTP ${res.status}`);
    return { items: [], quotaRemaining: null };
  }
  const body = (await res.json()) as SEResponse;
  if (body.error_id || body.error_message) {
    console.error(
      `[stackexchange] site=${site} sort=${sort} API error ${body.error_id ?? ''}: ${body.error_message ?? ''}`,
    );
    return { items: [], quotaRemaining: body.quota_remaining ?? null };
  }
  return {
    items: body.items ?? [],
    quotaRemaining: typeof body.quota_remaining === 'number' ? body.quota_remaining : null,
  };
}

// sinceMinutes は敢えて無視する (冒頭コメント参照)。
// 呼び出し側 (collect.ts) との引数シグネチャ互換のために受け取るのみ。
export async function collectStackExchange(_sinceMinutes: number): Promise<RawSignalInput[]> {
  const results: RawSignalInput[] = [];
  const counts: Record<string, number> = {};
  let lastQuota: number | null = null;

  // (site, sort) の直積を逐次取得。30 req/day 程度で SE のレート制限には余裕がある。
  for (const site of SITES) {
    for (const sort of SORTS) {
      try {
        const { items, quotaRemaining } = await fetchOne(site, sort);
        if (quotaRemaining !== null) lastQuota = quotaRemaining;
        for (const q of items) {
          if (!q.question_id || !q.title || !q.link || !q.creation_date) continue;

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
        counts[`${site}/${sort}`] = items.length;
      } catch (err) {
        console.error(`[stackexchange] site=${site} sort=${sort} failed:`, err);
      }
    }
  }

  const deduped = dedupByExternalId(results);
  console.log(
    `[stackexchange] raw=${results.length} deduped=${deduped.length} sites=${SITES.length} quota_remaining=${lastQuota ?? 'n/a'}`,
  );
  return deduped;
}

// sort=month と sort=hot の結果には重複が多いので必ず dedup する。
// また、稀に同 site で同 question_id が複数返ることもあり得るため防衛線として機能する。
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
