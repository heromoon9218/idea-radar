// reports の insert / 存在確認と ideas.delivered_at の更新。
// isAlreadyDelivered でメール送信前に当日配信済みか判定し、二重配信を防ぐ。

import { supabase } from '../db/supabase.js';
import type { ReportSlot } from './slot.js';

export interface RecordReportArgs {
  date: string;
  slot: ReportSlot;
  ideaIds: string[];
  resendId: string | null;
}

export async function isAlreadyDelivered(
  date: string,
  slot: ReportSlot,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('reports')
    .select('id')
    .eq('date', date)
    .eq('slot', slot)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

export async function recordReport(args: RecordReportArgs): Promise<void> {
  // insert 一発。UNIQUE(date, slot) 衝突時は呼び出し側に throw する
  // (呼び出し側は isAlreadyDelivered で事前チェック済みなので、ここで衝突するのは race のみ)。
  const { error } = await supabase.from('reports').insert({
    date: args.date,
    slot: args.slot,
    idea_ids: args.ideaIds,
    resend_id: args.resendId,
  });
  if (error) throw error;
}

export async function markIdeasDelivered(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase
    .from('ideas')
    .update({ delivered_at: new Date().toISOString() })
    .in('id', ids);
  if (error) throw error;
}
