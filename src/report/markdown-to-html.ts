// SPEC テンプレートが使う機能だけに限った最小 Markdown → HTML 変換器。
// サポート: # / ##, ---, **bold**, [text](url), 段落, 空行区切り。
// それ以外の記法 (code fence, list, blockquote 等) は現状テンプレートに存在しないため未対応。
// 出力はインライン CSS のみで Gmail 等のクライアントに耐える最小フォーマット。

interface InlineToken {
  type: 'text' | 'strong' | 'link';
  text: string;
  href?: string;
}

export function markdownToHtml(markdown: string, subject: string): string {
  const body = renderBlocks(markdown);
  return [
    '<!doctype html>',
    '<html lang="ja">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(subject)}</title>`,
    '</head>',
    '<body style="font-family: -apple-system, BlinkMacSystemFont, \'Helvetica Neue\', sans-serif; max-width: 680px; margin: 0 auto; padding: 24px; line-height: 1.65; color: #1a1a1a;">',
    body,
    '<hr style="margin-top: 32px; border: 0; border-top: 1px solid #ddd;"/>',
    '<p style="font-size: 12px; color: #888;">IdeaRadar Personal / 自動配信</p>',
    '</body>',
    '</html>',
  ].join('\n');
}

function renderBlocks(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const html = paragraph.map(renderInline).join('<br/>');
    out.push(`<p style="margin: 0 0 12px;">${html}</p>`);
    paragraph = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line === '') {
      flushParagraph();
      continue;
    }
    if (line === '---') {
      flushParagraph();
      out.push('<hr style="margin: 20px 0; border: 0; border-top: 1px solid #eee;"/>');
      continue;
    }
    if (line.startsWith('## ')) {
      flushParagraph();
      out.push(
        `<h2 style="font-size: 18px; margin: 24px 0 10px;">${renderInline(line.slice(3))}</h2>`,
      );
      continue;
    }
    if (line.startsWith('# ')) {
      flushParagraph();
      out.push(
        `<h1 style="font-size: 22px; margin: 0 0 16px;">${renderInline(line.slice(2))}</h1>`,
      );
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return out.join('\n');
}

function renderInline(line: string): string {
  return tokenizeInline(line)
    .map((t) => {
      switch (t.type) {
        case 'strong':
          return `<strong>${escapeHtml(t.text)}</strong>`;
        case 'link': {
          const href = sanitizeHref(t.href ?? '');
          return `<a href="${escapeHtml(href)}" style="color: #0b6bcb;">${escapeHtml(t.text)}</a>`;
        }
        case 'text':
        default:
          return escapeHtml(t.text);
      }
    })
    .join('');
}

// **bold** と [text](url) を 1 パスで抽出する tokenizer。
// Markdown のエスケープ (\*, \[) は render-markdown.ts 側で生成した文字列にのみ出現するので、
// ここではエスケープ解除しつつ文字として扱う。
function tokenizeInline(line: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let buf = '';

  const flushText = () => {
    if (buf.length === 0) return;
    tokens.push({ type: 'text', text: buf });
    buf = '';
  };

  let i = 0;
  while (i < line.length) {
    const ch = line[i];

    // escaped character ( \* → *, \[ → [, \\ → \, \` → ` )
    if (ch === '\\' && i + 1 < line.length) {
      buf += line[i + 1];
      i += 2;
      continue;
    }

    // **bold**
    if (ch === '*' && line[i + 1] === '*') {
      const end = line.indexOf('**', i + 2);
      if (end !== -1) {
        flushText();
        tokens.push({ type: 'strong', text: unescapeInline(line.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    // [text](url)
    if (ch === '[') {
      const closeBracket = findUnescaped(line, ']', i + 1);
      if (closeBracket !== -1 && line[closeBracket + 1] === '(') {
        const closeParen = line.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          flushText();
          const text = unescapeInline(line.slice(i + 1, closeBracket));
          const href = line.slice(closeBracket + 2, closeParen);
          tokens.push({ type: 'link', text, href });
          i = closeParen + 1;
          continue;
        }
      }
    }

    buf += ch;
    i++;
  }
  flushText();
  return tokens;
}

function findUnescaped(s: string, target: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === target) return i;
  }
  return -1;
}

function unescapeInline(text: string): string {
  return text.replace(/\\([\\`*\[\]])/g, '$1');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// href の javascript: / data: スキームを拒否。
// raw_signals の URL はコレクタで z.string().url() 済みだが、二重防御として残す。
function sanitizeHref(href: string): string {
  const trimmed = href.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^\//.test(trimmed)) return trimmed;
  return '#';
}
