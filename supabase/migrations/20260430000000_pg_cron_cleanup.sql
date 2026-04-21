-- raw_signals の定期クリーンアップ
-- analyze 済み (processed=true) かつ collected_at が 30 日以上前のレコードを
-- 毎日 UTC 01:00 (JST 10:00) に削除する。
-- pipeline (collect UTC22:00 → analyze UTC23:00 → deliver UTC23:30) が完了した後に走る時間設定。
--
-- ideas.source_signal_ids が dangling 参照になる可能性があるが、FK は張っておらず、
-- 配信済み ideas は reports.idea_ids から辿れるため監査上の実害はない (配信前の raw_signals は
-- 30 日以内なので生き残る想定)。
-- processed=false のまま残った失敗レコードはクリーンアップ対象外 (意図的に手動調査用に残す)。

create extension if not exists pg_cron;
grant usage on schema cron to postgres;

-- 冪等性: 同名ジョブが既にあれば unschedule してから再登録する
do $$
declare
  jid bigint;
begin
  select jobid into jid from cron.job where jobname = 'cleanup_raw_signals';
  if jid is not null then
    perform cron.unschedule(jid);
  end if;
end $$;

select cron.schedule(
  'cleanup_raw_signals',
  '0 1 * * *',
  $$delete from raw_signals where processed = true and collected_at < now() - interval '30 days'$$
);
