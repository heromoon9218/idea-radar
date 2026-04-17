-- raw_signals: 各ソースから収集した生データ
-- 6時間おきに収集、UNIQUE(source, external_id) で重複除外

create extension if not exists "uuid-ossp";

do $$ begin
  create type source_type as enum ('hatena', 'zenn', 'hackernews');
exception
  when duplicate_object then null;
end $$;

create table if not exists raw_signals (
  id uuid primary key default uuid_generate_v4(),
  source source_type not null,
  external_id text not null,
  url text not null,
  title text not null,
  content text,
  author text,
  posted_at timestamptz not null,
  collected_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  processed boolean not null default false,
  unique (source, external_id)
);

create index if not exists idx_raw_signals_collected_at on raw_signals (collected_at desc);
create index if not exists idx_raw_signals_unprocessed on raw_signals (processed) where processed = false;
create index if not exists idx_raw_signals_source_posted on raw_signals (source, posted_at desc);
