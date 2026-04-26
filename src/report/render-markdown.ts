// SPEC.md のテンプレートに従って Top アイデア群を Markdown に整形する。
// 入力は IdeaWithSources[] (source_links, competitors は既に解決済み)。

import type {
  DistributionHypothesis,
  FermiEstimate,
  FermiUnitType,
  IdeaCategory,
  RiskFlag,
  RiskSeverity,
  SnsDependency,
} from '../types.js';
import type { IdeaWithSources, SourceLink } from './select-ideas.js';
import { TARGET_MRR } from '../lib/goal-band.js';

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
  stackexchange: 'Stack Exchange',
};

const FERMI_UNIT_JA: Record<FermiUnitType, string> = {
  monthly: '月額',
  one_time: '買い切り',
  per_use: '従量課金',
};

// Sprint B-2: severity に応じた警告マーク。絵文字はメール配信先でも表示される前提。
const RISK_SEVERITY_JA: Record<RiskSeverity, string> = {
  high: '🚨 high',
  mid: '⚠️ mid',
  low: 'ℹ️ low',
};

// Sprint C-1: SNS バイラル依存度ラベル。high は「再現性が低い」のサイン。
const SNS_DEPENDENCY_JA: Record<SnsDependency, string> = {
  high: '高 (バズ前提)',
  mid: '中',
  low: '低 (SNS 不要でも届く)',
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
    lines.push(`## ${i + 1}. ${escapeInline(idea.title)}`);
    lines.push('');
    lines.push(`**WHY (誰のどんな痛みか)**: ${escapeInline(idea.why)}`);
    lines.push('');
    lines.push(`**WHAT (何を作るか)**: ${escapeInline(idea.what)}`);
    lines.push('');
    // 旧 ideas (why/what/how マイグレーション以前にバックフィルされた行) では how が空文字で残る。
    // 空の見出し行を出さないようガードする。新規 analyze 経由の行は zod min(1) で非空保証済み。
    if (idea.how.trim().length > 0) {
      lines.push(`**HOW (どう実現するか)**: ${escapeInline(idea.how)}`);
      lines.push('');
    }
    lines.push(`**カテゴリ**: ${CATEGORY_JA[idea.category]}`);
    lines.push('');
    // weighted_score は Sprint A-3 で導入した帯別重み付きスコア (numeric, 小数 2 桁)。
    // 3 軸は従来通り 1-5 で表示し、合計欄は重み適用後の値を 1 桁目まで示す。
    lines.push(
      `**スコア**: 市場性 ${idea.market_score}/5 · 技術 ${idea.tech_score}/5 · 競合少 ${idea.competition_score}/5 · 合計 ${idea.weighted_score.toFixed(1)}（重み付き）`,
    );
    lines.push('');
    // Sprint B-3: フェルミ推定を表示。旧行 (fermi_estimate=null) はスキップ。
    if (idea.fermi_estimate) {
      lines.push(
        `**月 ${formatTargetMrr()} 到達**: ${escapeInline(formatFermi(idea.fermi_estimate))}`,
      );
      lines.push('');
    }
    // Sprint C-1: 流通仮説を表示。旧行 (distribution_hypothesis=null) はスキップ。
    if (idea.distribution_hypothesis) {
      lines.push(`**流通仮説**: ${formatDistribution(idea.distribution_hypothesis)}`);
      lines.push('');
    }
    lines.push(`**類似サービス**: ${formatCompetitors(idea.competitors)}`);
    lines.push('');
    // Sprint B-2: リスク検出が 1 件以上ある場合のみ警告セクションを出す。
    if (idea.risk_flags.length > 0) {
      lines.push(`**⚠️ リスク**: ${formatRiskFlags(idea.risk_flags)}`);
      lines.push('');
    }
    lines.push(`**元情報**: ${formatSourceLinks(idea.sources)}`);
    lines.push('');
    lines.push('---');
    lines.push('');
  });

  return lines.join('\n');
}

// TARGET_MRR (円) を「5 万円」形式に丸めて表示する。
// 5,000 未満 → "X 千円"、それ以上 → "X 万円" を閾値に、端数は 1 桁。
function formatTargetMrr(): string {
  if (TARGET_MRR >= 10000) {
    return `${(TARGET_MRR / 10000).toLocaleString('en-US')} 万円`;
  }
  return `${TARGET_MRR.toLocaleString('en-US')} 円`;
}

function formatFermi(f: FermiEstimate): string {
  const unitLabel = FERMI_UNIT_JA[f.unit_type];
  const price = f.unit_price.toLocaleString('en-US');
  // mrr_formula は FermiEstimateSchema 側で min(1) 保証済みなので fallback は不要。
  return `${unitLabel} ${price} 円 — ${f.mrr_formula}`;
}

function formatRiskFlags(flags: RiskFlag[]): string {
  return flags
    .map((f) => {
      const sev = RISK_SEVERITY_JA[f.severity];
      return `${sev} ${escapeInline(f.kind)}: ${escapeInline(f.reason)}`;
    })
    .join(' / ');
}

// Sprint C-1: 流通仮説を 1 行で整形する。
// 「チャネル: X / Y / Z ｜ 初期 10 ユーザー: ... ｜ SNS 依存度: 高 (バズ前提)」
// インライン記述だが配信メールで読みづらくなるため改行は入れない (Markdown 段落崩れを避ける)。
function formatDistribution(d: DistributionHypothesis): string {
  const channels = d.channels.map((c) => escapeInline(c)).join(' / ');
  const first10 = escapeInline(d.first_10_users);
  const sns = SNS_DEPENDENCY_JA[d.sns_dependency];
  return `チャネル: ${channels} ｜ 初期 10 ユーザー: ${first10} ｜ SNS 依存度: ${sns}`;
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
