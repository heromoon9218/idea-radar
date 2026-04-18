// Resend v6 の薄いラッパ。
// API キーは遅延初期化 (smoke --deliver-dry など送信を伴わない経路では env 不要)。
// 返り値は Resend が採番した email id (取得失敗時は null)。

import { Resend, type CreateEmailOptions } from 'resend';

let _client: Resend | null = null;

function getClient(): Resend {
  if (_client) return _client;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is required');
  _client = new Resend(key);
  return _client;
}

export interface SendReportEmailArgs {
  subject: string;
  markdown: string; // text フォールバック用
  html: string;     // 空文字なら html を省略し text のみで送信
}

export async function sendReportEmail(args: SendReportEmailArgs): Promise<string | null> {
  const from = process.env.RESEND_FROM_EMAIL;
  const to = process.env.RECIPIENT_EMAIL;
  if (!from) throw new Error('RESEND_FROM_EMAIL is required');
  if (!to) throw new Error('RECIPIENT_EMAIL is required');

  const client = getClient();
  // CreateEmailOptions は RequireAtLeastOne<{ react, html, text }>。
  // html 空文字のときは text のみで送る。
  const base = { from, to, subject: args.subject } as const;
  const payload: CreateEmailOptions = args.html
    ? { ...base, text: args.markdown, html: args.html }
    : { ...base, text: args.markdown };

  const { data, error } = await client.emails.send(payload);
  if (error) {
    throw new Error(`[resend] send failed: ${error.message ?? JSON.stringify(error)}`);
  }
  return data?.id ?? null;
}
