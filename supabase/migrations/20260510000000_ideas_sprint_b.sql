-- Sprint B: 起草/スコアリングの構造追加
-- B-1 Devil's advocate の却下理由と再スコア、B-2 赤旗スキャンの risk_flags、
-- B-3 フェルミ推定 (unit_price / unit_type / mrr_formula) を ideas に保持する。
-- いずれも nullable / 空配列デフォルトにして、マイグレーション前後で既存行を壊さない。

-- B-1: 2-pass スコアリングで生成した却下理由と再評価サマリ (再スコア値は
-- market_score 等の正規列に反映するため、ここでは reasoning のみ保持する)。
-- 構造: { rejection_reasons: string[], verdict: string,
--         initial_scores: { market, tech, competition } }
alter table ideas add column if not exists devils_advocate jsonb;

-- B-2: 赤旗スキャン結果。空配列デフォルトで、配列ゼロ件なら「リスク未検出」扱い。
-- 構造: Array<{ kind: string, severity: 'low'|'mid'|'high', reason: string }>
alter table ideas add column if not exists risk_flags jsonb not null default '[]'::jsonb;

-- B-3: フェルミ推定。
-- 構造: { unit_price: number (円), unit_type: 'monthly'|'one_time'|'per_use',
--         mrr_formula: string (例: "買い切り 3,000 円 × 月 17 本 = 51,000 円") }
-- 推定不可だった場合に drafter 側で除外する運用のため nullable。
alter table ideas add column if not exists fermi_estimate jsonb;
