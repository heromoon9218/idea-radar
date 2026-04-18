// 配信スロットと日付ユーティリティ。
// JST は UTC+9 で DST なし。deliver は現状 1 日 1 回 am 固定。
// pm を追加する場合は resolveSlotBase 内で JST 時刻を見て分岐する。

export type ReportSlot = 'am' | 'pm';

export interface SlotBase {
  date: string;       // 'YYYY-MM-DD' (JST)
  slot: ReportSlot;   // 現状は常に 'am'
  slotLabel: string;  // 日本語 ('朝' | '夜')
  filename: string;   // 'reports/YYYY-MM-DD-am.md'
}

const SLOT_LABELS: Record<ReportSlot, string> = {
  am: '朝',
  pm: '夜',
};

export function toJstDateString(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

export function resolveSlotBase(now: Date): SlotBase {
  const date = toJstDateString(now);
  const slot: ReportSlot = 'am';
  const slotLabel = SLOT_LABELS[slot];
  return {
    date,
    slot,
    slotLabel,
    filename: `reports/${date}-${slot}.md`,
  };
}

export function buildSubject(base: SlotBase, ideaCount: number): string {
  return `IdeaRadar ${base.slotLabel} ${base.date} Top ${ideaCount}`;
}
