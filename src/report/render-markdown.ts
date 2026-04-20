// SPEC.md のテンプレートに従って Top アイデア群を Markdown に整形する。
// 入力は IdeaWithSources[] (source_links, competitors は既に解決済み)。

import type { IdeaCategory } from '../types.js';
import type { IdeaWithSources, SourceLink } from './select-ideas.js';

export interface RenderContext {
  date: string;       // 'YYYY-MM-DD' (JST)
  slotLabel: string;  // '朝' | '夜'
}

const CATEGORY_JA: Record<IdeaCategory, string> = {
  'dev-tool': '開発ツール',
  productivity: '生産性',
  saas: 'SaaS',
  ai: 'AI',
  other: 'その他',
};

const SOURCE_JA: Record<SourceLink['source'], string> = {
  hatena: 'はてブ',
  zenn: 'Zenn',
  hackernews: 'HN',
};

const TITLE_TRUNCATE = 60;

export function renderMarkdown(ideas: IdeaWithSources[], ctx: RenderContext): string {
  const lines: string[] = [];
  lines.push(`# IdeaRadar - ${ctx.date} ${ctx.slotLabel}`);
  lines.push('');
  lines.push(`直近 24 時間のトップアイデア ${ideas.length} 件`);
  lines.push('');
  lines.push('---');
  lines.push('');

  ideas.forEach((idea, i) => {
    const total = idea.market_score + idea.tech_score + idea.competition_score;
    lines.push(`## ${i + 1}. ${escapeInline(idea.title)}`);
    lines.push('');
    lines.push(`**WHY (誰のどんな痛みか)**: ${escapeInline(idea.why)}`);
    lines.push('');
    lines.push(`**WHAT (何を作るか)**: ${escapeInline(idea.what)}`);
    lines.push('');
    lines.push(`**HOW (どう実現するか)**: ${escapeInline(idea.how)}`);
    lines.push('');
    lines.push(`**カテゴリ**: ${CATEGORY_JA[idea.category]}`);
    lines.push('');
    lines.push(
      `**スコア**: 市場性 ${idea.market_score}/5 · 技術 ${idea.tech_score}/5 · 競合少 ${idea.competition_score}/5 · 合計 ${total}/15`,
    );
    lines.push('');
    lines.push(`**類似サービス**: ${formatCompetitors(idea.competitors)}`);
    lines.push('');
    lines.push(`**元情報**: ${formatSourceLinks(idea.sources)}`);
    lines.push('');
    lines.push('---');
    lines.push('');
  });

  return lines.join('\n');
}

function formatCompetitors(competitors: IdeaWithSources['competitors']): string {
  if (competitors.length === 0) return 'なし';
  return competitors
    .map((c) => {
      const name = escapeInline(c.name);
      if (c.url && isSafeExternalUrl(c.url)) {
        return `[${name}](${encodeMarkdownUrl(c.url)})`;
      }
      return name;
    })
    .join(' / ');
}

// zod の z.string().url() は寛容で、LLM が JSON 境界を URL value に垂れ流したケース
// (例: "https://example.com/foo',note:'bar") を通してしまうことがあるため、
// ここで追加の厳格判定を行う。URL に通常含まれない記号 (クォート類・波括弧) を
// 1 文字でも検出したら壊れた URL として捨て、name のみ表示に fallback する。
function isSafeExternalUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (/['"{}]/.test(raw)) return false;
    return true;
  } catch {
    return false;
  }
}

function formatSourceLinks(sources: SourceLink[]): string {
  if (sources.length === 0) return '（元情報の URL を取得できませんでした）';
  return sources
    .map((s) => {
      const label = `${SOURCE_JA[s.source]}: ${truncate(s.title, TITLE_TRUNCATE)}`;
      return `[${escapeInline(label)}](${encodeMarkdownUrl(s.url)})`;
    })
    .join(' / ');
}

// Markdown リンクテキスト / 段落内に現れる LLM 由来テキストの安全化。
// - [ ] や * を壊さない程度に最低限のエスケープのみ
// - バッククォート ``` の混入でコードブロック化するのを防ぐため ` もエスケープ
function escapeInline(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\r?\n/g, ' ');
}

function encodeMarkdownUrl(url: string): string {
  // ()（) が URL に含まれる場合に Markdown パーサを壊さないようエスケープ
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}
