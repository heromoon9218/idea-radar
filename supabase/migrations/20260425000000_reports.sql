-- reports: 配信ログ
-- deliver ワークフローが 1 日 1 回、Markdown レポート送信後に 1 行 insert する。
-- UNIQUE(date, slot) により二重配信を防ぐ:
--   deliver は insert 前に isAlreadyDelivered で事前チェックし、race 時のみ呼び出し側に throw。
-- idea_ids は FK 無しの緩い参照 (uuid[] は行単位 FK を持てないため)。
--   deliver 側が idea_ids を参照して「直近 2 日に配信済みの idea は再配信しない」保護を掛けるので、
--   このカラムは単なる監査ログ以上の役割を持つ。
-- Markdown 本文はメール送信のみで Git には残らないため、ideas 行削除時のリカバリは
-- メール (Resend ログ) または ideas 再生成でしか復元できない。

do $$ begin
  create type report_slot as enum ('am', 'pm');
exception
  when duplicate_object then null;
end $$;

create table if not exists reports (
  id uuid primary key default uuid_generate_v4(),
  date date not null,
  slot report_slot not null,
  idea_ids uuid[] not null default '{}'::uuid[],
  email_sent_at timestamptz not null default now(),
  resend_id text,
  created_at timestamptz not null default now(),
  unique (date, slot)
);

create index if not exists idx_reports_date_desc on reports (date desc, slot);
