-- Sprint A-3: ゴール帯別重み付きスコアを追加
-- TARGET_MRR (個人開発の月収ゴール) 帯に応じて market / tech / competition の重みを
-- 変えた weighted_score を保持する。重みは TypeScript 側で計算して insert するため
-- generated column にはしない (環境変数変更のたびに migration を打たずに済むように)。
-- 既存の total_score 列は互換のため残す。

alter table ideas add column if not exists weighted_score numeric(4,2);

-- 既存行は total_score をそのまま複製してバックフィル。
-- バックフィル値は近似であり、Sprint A 以降の新規 insert のみ帯に応じた正確な値になる。
update ideas set weighted_score = total_score where weighted_score is null;

alter table ideas alter column weighted_score set not null;

create index if not exists idx_ideas_weighted_score on ideas (weighted_score desc);
