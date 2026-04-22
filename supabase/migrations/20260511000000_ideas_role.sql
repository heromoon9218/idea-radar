-- ideas に drafter 役割 (aggregator / combinator / gap_finder) を永続化。
-- Sprint B 時点では ScoredWithWeight 中で保持するだけで DB には書き戻していなかったため、
-- 「どの役割が生んだアイデアか」を後から SQL で追跡できなかった。audit trail として残す。
-- Sprint B 以前の既存行は NULL のまま残す (retro で埋められない)。

do $$
begin
  if not exists (select 1 from pg_type where typname = 'idea_role') then
    create type idea_role as enum ('aggregator', 'combinator', 'gap_finder');
  end if;
end$$;

alter table ideas add column if not exists role idea_role;
