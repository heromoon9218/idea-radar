-- raw_signals.source を note/reddit から stackexchange に入れ替える破壊的マイグレーション。
--
-- 背景:
--   note / reddit は数値メタ (いいね / score) が取れず demand-summary が機能しないため
--   非技術ソースとして機能不全だった (PR #34 時点でも note/reddit は集計対象外の扱い)。
--   代替として Stack Exchange 非技術サイト (lifehacks / parenting / money) を追加する。
--   score / view_count / answer_count が API 経由で取れるため demand-summary に組み込める。
--
-- 案:
--   Postgres の enum は値の DROP をサポートしないため、新しい enum type を作って swap する。
--   既存の raw_signals rows のうち source in ('note','reddit') の行は事前に削除する
--   (SPEC の設計判断: 過去データは保持せず、今後の分析対象から外す)。
--
-- 手順:
--   1. 既存の note / reddit 行を削除
--   2. source_type_old へリネーム
--   3. 新しい source_type enum を作成 (hatena / zenn / hackernews / stackexchange)
--   4. raw_signals.source を新 enum 型にキャスト
--   5. 旧 source_type_old を DROP
--
-- 注意:
--   既存の ideas.source_signal_ids は uuid[] で enum 参照ではないため、
--   このマイグレーションの影響を受けない (note/reddit 由来の signals を参照する idea が
--   残っていても FK が無いので破綻しない。必要なら手動クレンジングする)。

begin;

delete from raw_signals where source::text in ('note', 'reddit');

alter type source_type rename to source_type_old;

create type source_type as enum ('hatena', 'zenn', 'hackernews', 'stackexchange');

alter table raw_signals
  alter column source type source_type using source::text::source_type;

drop type source_type_old;

commit;
