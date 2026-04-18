// 日次配信エントリ。
// 未配信 ideas Top 3-5 を取り → Markdown 生成 → Resend 送信 → reports 記録 → ideas.delivered_at 更新
// → reports/YYYY-MM-DD-am.md をローカルに出力 (commit はワークフロー側)。
//
// 冪等性:
//   1. 冒頭で isAlreadyDelivered を見て、同日 am slot が既に記録済みなら skip
//   2. ideas が 0 件なら skip (exit 0)
//   3. メール送信失敗 → exit 1。この時点で DB 変更なしなので再実行で再試行可能
//   4. recordReport 失敗 → メール送信済みなので markIdeasDelivered を failsafe で呼んでから exit 1
//      (次回の fetchUndeliveredTopIdeas が同じ ideas を拾って二重配信するのを防ぐ)
//   5. markIdeasDelivered 失敗 → warn のみ。reports には行があるため、
//      同日再実行は isAlreadyDelivered で skip される。翌日以降も
//      fetchUndeliveredTopIdeas 側が reports.idea_ids を参照する「reports ガード」で
//      同一 idea を除外するため、二重配信は発生しない

import 'dotenv/config';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import {
  attachSourceLinks,
  fetchUndeliveredTopIdeas,
} from './report/select-ideas.js';
import { renderMarkdown } from './report/render-markdown.js';
import { markdownToHtml } from './report/markdown-to-html.js';
import { buildSubject, resolveSlotBase } from './report/slot.js';
import {
  isAlreadyDelivered,
  markIdeasDelivered,
  recordReport,
} from './report/persist.js';
import { sendReportEmail } from './lib/resend.js';

async function writeGitHubOutput(
  values: { delivered: boolean; reportFile?: string },
): Promise<void> {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  const lines: string[] = [];
  lines.push(`delivered=${values.delivered ? 'true' : 'false'}`);
  if (values.reportFile) lines.push(`report_file=${values.reportFile}`);
  await fs.appendFile(path, lines.join('\n') + '\n');
}

async function main(): Promise<void> {
  const startedAt = new Date();
  console.log(`[deliver] started=${startedAt.toISOString()}`);

  const base = resolveSlotBase(startedAt);
  console.log(`[deliver] date=${base.date} slot=${base.slot}`);

  if (await isAlreadyDelivered(base.date, base.slot)) {
    console.log(
      `[deliver] already delivered for ${base.date} ${base.slot}, skipping`,
    );
    await writeGitHubOutput({ delivered: false });
    return;
  }

  const ideas = await fetchUndeliveredTopIdeas();
  console.log(`[deliver] candidates=${ideas.length}`);

  if (ideas.length === 0) {
    console.log('[deliver] no undelivered ideas, skipping');
    await writeGitHubOutput({ delivered: false });
    return;
  }

  const enriched = await attachSourceLinks(ideas);
  const subject = buildSubject(base, enriched.length);
  console.log(`[deliver] subject="${subject}"`);

  const markdown = renderMarkdown(enriched, {
    date: base.date,
    slotLabel: base.slotLabel,
  });
  let html = '';
  try {
    html = markdownToHtml(markdown, subject);
  } catch (err) {
    console.warn(
      '[deliver] html render failed, falling back to text only:',
      err instanceof Error ? err.message : err,
    );
  }

  // メール送信の前にローカルへ書き出しておく (送信成功 → ファイル commit の順)。
  // 送信に失敗したら exit 1 で commit ステップがスキップされる。
  await fs.mkdir(dirname(base.filename), { recursive: true });
  await fs.writeFile(base.filename, markdown, 'utf8');
  console.log(`[deliver] wrote ${base.filename}`);

  const resendId = await sendReportEmail({ subject, markdown, html });
  console.log(`[deliver] sent, resend_id=${resendId ?? '(none)'}`);

  // ここ以降はメール送信済み。DB 整合失敗時も二重配信を防ぐため、
  // recordReport が落ちても markIdeasDelivered は必ず呼ぶ。
  const ideaIds = enriched.map((i) => i.id);
  try {
    await recordReport({
      date: base.date,
      slot: base.slot,
      ideaIds,
      resendId,
    });
    console.log('[deliver] reports recorded');
  } catch (err) {
    console.error('[deliver] record report failed:', err);
    try {
      await markIdeasDelivered(ideaIds);
      console.warn('[deliver] failsafe markIdeasDelivered applied');
    } catch (innerErr) {
      console.error(
        '[deliver] failsafe markIdeasDelivered also failed:',
        innerErr instanceof Error ? innerErr.message : innerErr,
      );
    }
    process.exit(1);
  }

  try {
    await markIdeasDelivered(ideaIds);
    console.log(`[deliver] marked ${ideaIds.length} ideas delivered`);
  } catch (err) {
    // 同日再実行は isAlreadyDelivered で、翌日以降は fetchUndeliveredTopIdeas の
    // reports ガード (直近 2 日の idea_ids を除外) で保護されるので警告のみで継続
    console.warn(
      '[deliver] mark delivered failed (protected by reports gate in fetch):',
      err instanceof Error ? err.message : err,
    );
  }

  await writeGitHubOutput({ delivered: true, reportFile: base.filename });
  console.log(`[deliver] done=${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error('[deliver] unhandled:', err);
  process.exit(1);
});
