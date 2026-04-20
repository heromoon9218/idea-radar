-- ideas: pain_summary + idea_description を why / what / how の 3 フィールドに分離。
-- WHY = 誰のどんな痛みか (ターゲット + 状況 + 困りごと)
-- WHAT = 何を作るか + 差別化 + 収益モデル
-- HOW = どう実現するか (技術スタック + MVP 構成 + 実装難度)
--
-- 既存行 (delivered 済み or 24h 超過で select されないもの) に対しては
-- pain_summary を why に、idea_description を what にバックフィルし、how は空文字列にする。
-- 以降、新規 insert は analyze パイプライン経由で必ず 3 フィールド揃う。

alter table ideas add column if not exists why text;
alter table ideas add column if not exists what text;
alter table ideas add column if not exists how text;

update ideas
set
  why  = coalesce(why,  pain_summary),
  what = coalesce(what, idea_description),
  how  = coalesce(how,  '')
where why is null or what is null or how is null;

alter table ideas alter column why  set not null;
alter table ideas alter column what set not null;
alter table ideas alter column how  set not null;

alter table ideas drop column if exists pain_summary;
alter table ideas drop column if exists idea_description;
