// LLM model ID の single source of truth。
// analyzers 配下で個別に同じ文字列を const 定義していたのを一元化する。
// モデル更新 (例: Sonnet 4.6 → 4.7) はこのファイルだけ差し替えれば全役割に反映される。

export const SONNET_MODEL = 'claude-sonnet-4-6';
export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
