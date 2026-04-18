-- ideas: Haiku 構造化 + Sonnet スコアリング済みアイデア
-- 12h おきに analyze ワークフローが直近 12h の raw_signals から Top 3-5 件を insert する。
-- total_score は 3 軸の合計を自動計算 (generated column)。
-- delivered_at は S3 の配信時に更新される (NULL = 未配信)。

create table if not exists ideas (
  id uuid primary key default uuid_generate_v4(),
  title text not null,
  pain_summary text not null,
  idea_description text not null,
  category text not null
    check (category in ('dev-tool', 'productivity', 'saas', 'ai', 'other')),
  market_score int not null check (market_score between 1 and 5),
  tech_score int not null check (tech_score between 1 and 5),
  competition_score int not null check (competition_score between 1 and 5),
  total_score int not null generated always as
    (market_score + tech_score + competition_score) stored,
  competitors jsonb not null default '[]'::jsonb,
  source_signal_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);

create index if not exists idx_ideas_created_at on ideas (created_at desc);
create index if not exists idx_ideas_undelivered on ideas (delivered_at)
  where delivered_at is null;
create index if not exists idx_ideas_total_score on ideas (total_score desc);
