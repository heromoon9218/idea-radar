// 配信スロットと日付ユーティリティ。
// JST は UTC+9 で DST なし。deliver は現状 週 1 回 (Sat 朝) am 固定。
// reports.UNIQUE(date, slot) は date の自然な uniqueness で週次運用でも機能する
// (Saturday 1 日に 1 回しか発火しない)。

export type ReportSlot = 'am' | 'pm';

export interface SlotBase {
  date: string;       // 'YYYY-MM-DD' (JST)
  slot: ReportSlot;   // 現状は常に 'am'
  slotLabel: string;  // 日本語 ('朝' | '夜')
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
  };
}

export function buildSubject(base: SlotBase, ideaCount: number): string {
  return `IdeaRadar ${base.slotLabel} ${base.date} Top ${ideaCount}`;
}
