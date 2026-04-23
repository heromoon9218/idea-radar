// バンドル単位で raw_signals.metadata を集計して drafter 用のサマリを作る。
// Sprint A-1 で追加。目的は「累計 240 bkm」「HN 平均 87pt」のような定量シグナルを
// Sonnet drafter に渡して痛みの強度を raw_score / WHY の根拠に反映させること。
//
// ソース横断で合算しない設計: hatena bkm / zenn likes / HN score / SE vote は意味が違うため
// ソース別に分けて集計する (合算値は誤読されやすい)。

import type { SourceType } from '../types.js';

interface SignalMetaRef {
  source: SourceType;
  metadata: Record<string, unknown> | null;
}

interface HatenaStats {
  articleCount: number;
  totalBookmarks: number;
  maxBookmarks: number;
}

interface ZennStats {
  articleCount: number;
  totalLikes: number;
  maxLikes: number;
  totalBookmarks: number;
  totalComments: number;
}

interface HackerNewsStats {
  articleCount: number;
  totalScore: number;
  avgScore: number;
  maxScore: number;
  totalComments: number;
}

interface StackExchangeStats {
  articleCount: number;
  totalScore: number;    // 累計 votes
  avgScore: number;
  maxScore: number;
  totalViews: number;    // 累計 view_count (閲覧数)
  maxViews: number;
  totalAnswers: number;  // 累計 answer_count
  answeredCount: number; // ベストアンサー済みの件数 (残り = 未解決の生きた痛み)
}

export interface DemandSummary {
  signalCount: number;
  hatena?: HatenaStats;
  zenn?: ZennStats;
  hackernews?: HackerNewsStats;
  stackexchange?: StackExchangeStats;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function buildDemandSummary(
  signalIds: string[],
  metadataById: Map<string, SignalMetaRef>,
): DemandSummary | null {
  const hatenaBkm: number[] = [];
  const zennLikes: number[] = [];
  const zennBkm: number[] = [];
  const zennComments: number[] = [];
  const hnScores: number[] = [];
  const hnComments: number[] = [];
  const seScores: number[] = [];
  const seViews: number[] = [];
  const seAnswers: number[] = [];
  let seAnsweredCount = 0;
  let resolvedCount = 0;

  for (const id of signalIds) {
    const ref = metadataById.get(id);
    if (!ref) continue;
    resolvedCount += 1;
    const meta = ref.metadata ?? {};
    if (ref.source === 'hatena') {
      const bkm = toNumber(meta.bookmark_count);
      if (bkm !== null) hatenaBkm.push(bkm);
    } else if (ref.source === 'zenn') {
      const likes = toNumber(meta.liked_count);
      const bkm = toNumber(meta.bookmarked_count);
      const comments = toNumber(meta.comments_count);
      if (likes !== null) zennLikes.push(likes);
      if (bkm !== null) zennBkm.push(bkm);
      if (comments !== null) zennComments.push(comments);
    } else if (ref.source === 'hackernews') {
      const score = toNumber(meta.score);
      const comments = toNumber(meta.descendants);
      if (score !== null) hnScores.push(score);
      if (comments !== null) hnComments.push(comments);
    } else if (ref.source === 'stackexchange') {
      const score = toNumber(meta.question_score);
      const views = toNumber(meta.view_count);
      const answers = toNumber(meta.answer_count);
      if (score !== null) seScores.push(score);
      if (views !== null) seViews.push(views);
      if (answers !== null) seAnswers.push(answers);
      if (meta.is_answered === true) seAnsweredCount += 1;
    }
  }

  if (resolvedCount === 0) return null;

  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  const max = (xs: number[]): number => (xs.length === 0 ? 0 : Math.max(...xs));
  const avg = (xs: number[]): number =>
    xs.length === 0 ? 0 : Math.round(sum(xs) / xs.length);

  const summary: DemandSummary = { signalCount: resolvedCount };
  if (hatenaBkm.length > 0) {
    summary.hatena = {
      articleCount: hatenaBkm.length,
      totalBookmarks: sum(hatenaBkm),
      maxBookmarks: max(hatenaBkm),
    };
  }
  if (zennLikes.length > 0 || zennBkm.length > 0) {
    summary.zenn = {
      articleCount: Math.max(zennLikes.length, zennBkm.length, zennComments.length),
      totalLikes: sum(zennLikes),
      maxLikes: max(zennLikes),
      totalBookmarks: sum(zennBkm),
      totalComments: sum(zennComments),
    };
  }
  if (hnScores.length > 0) {
    summary.hackernews = {
      articleCount: hnScores.length,
      totalScore: sum(hnScores),
      avgScore: avg(hnScores),
      maxScore: max(hnScores),
      totalComments: sum(hnComments),
    };
  }
  if (seScores.length > 0 || seViews.length > 0) {
    summary.stackexchange = {
      articleCount: Math.max(seScores.length, seViews.length, seAnswers.length),
      totalScore: sum(seScores),
      avgScore: avg(seScores),
      maxScore: max(seScores),
      totalViews: sum(seViews),
      maxViews: max(seViews),
      totalAnswers: sum(seAnswers),
      answeredCount: seAnsweredCount,
    };
  }

  // signalCount 以外に意味のあるソース別集計が 1 つも無ければ null を返す。
  const hasAnySource =
    summary.hatena || summary.zenn || summary.hackernews || summary.stackexchange;
  if (!hasAnySource) return null;
  return summary;
}

// 人間可読な Markdown 風テキストに整形 (drafter の user prompt に差し込む)。
// 値がゼロのフィールドは省略。
export function formatDemandSummaryForPrompt(summary: DemandSummary): string {
  const lines: string[] = [];
  lines.push('# 需要シグナルサマリ');
  lines.push(`- 総シグナル数: ${summary.signalCount}`);
  if (summary.hatena) {
    const h = summary.hatena;
    lines.push(
      `- はてブ ${h.articleCount} 記事: 累計 ${h.totalBookmarks} bkm (最大 ${h.maxBookmarks})`,
    );
  }
  if (summary.zenn) {
    const z = summary.zenn;
    const parts: string[] = [];
    if (z.totalLikes > 0) parts.push(`累計 likes ${z.totalLikes} (最大 ${z.maxLikes})`);
    if (z.totalBookmarks > 0) parts.push(`累計 bookmarks ${z.totalBookmarks}`);
    if (z.totalComments > 0) parts.push(`累計 comments ${z.totalComments}`);
    if (parts.length > 0) {
      lines.push(`- Zenn ${z.articleCount} 記事: ${parts.join(' / ')}`);
    }
  }
  if (summary.hackernews) {
    const hn = summary.hackernews;
    const parts: string[] = [];
    parts.push(`累計 score ${hn.totalScore} (平均 ${hn.avgScore}, 最大 ${hn.maxScore})`);
    if (hn.totalComments > 0) parts.push(`累計 comments ${hn.totalComments}`);
    lines.push(`- HN ${hn.articleCount} 記事: ${parts.join(' / ')}`);
  }
  if (summary.stackexchange) {
    const se = summary.stackexchange;
    const parts: string[] = [];
    parts.push(`累計 votes ${se.totalScore} (平均 ${se.avgScore}, 最大 ${se.maxScore})`);
    if (se.totalViews > 0) parts.push(`累計 views ${se.totalViews} (最大 ${se.maxViews})`);
    if (se.totalAnswers > 0) {
      const unanswered = se.articleCount - se.answeredCount;
      parts.push(`回答 ${se.totalAnswers} (未解決 ${unanswered}/${se.articleCount})`);
    }
    lines.push(`- Stack Exchange ${se.articleCount} 質問: ${parts.join(' / ')}`);
  }
  lines.push(
    '',
    'これらの値は「痛みが複数人で裏取れているか」の強度指標です。WHY に 1 箇所以上の定量引用 (「累計 240 bkm」等) を含め、raw_score に反映してください。',
  );
  return lines.join('\n');
}

// analyze ログに集計値を出すための 1 行形式。
export function logLineDemandSummary(
  label: string,
  summary: DemandSummary | null,
): string {
  if (!summary) return `[analyze] demand_summary ${label} none`;
  const parts: string[] = [`signals=${summary.signalCount}`];
  if (summary.hatena) parts.push(`bkm_total=${summary.hatena.totalBookmarks}`);
  if (summary.zenn) parts.push(`zenn_likes=${summary.zenn.totalLikes}`);
  if (summary.hackernews) parts.push(`hn_avg=${summary.hackernews.avgScore}`);
  if (summary.stackexchange) {
    parts.push(
      `se_avg=${summary.stackexchange.avgScore} se_views=${summary.stackexchange.totalViews}`,
    );
  }
  return `[analyze] demand_summary ${label} ${parts.join(' ')}`;
}
