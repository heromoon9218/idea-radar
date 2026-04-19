// Anthropic SDK v0.90: messages.parse + zodOutputFormat で構造化出力を 1 発で取る薄いラッパ。
// API キーは遅延初期化する。smoke (コレクタ単体) など LLM を呼ばない経路でも
// 本ファイルが transitively import されるため、トップレベル throw は回避。
//
// Prompt caching:
// - cacheSystem=true で system プロンプトに cache_control=ephemeral を付ける
// - 5 分以内に同じ system で再呼び出しすれば cached_input_tokens がカウントされ、
//   システム部分は通常の入力トークン料金の 10% に割引される
// - 書き込み (初回) は 1.25x のコストがかかるため、2 回以上呼ぶ経路でのみ有効化する
// - 同日実行でも analyze 1 回のみだと書き込み分だけ損するので、Sonnet の
//   3 役割ドラフトと 3 軸スコアリング (10 回) のように複数回呼ぶ経路で特に効く

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { ZodType, infer as ZodInfer } from 'zod';

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

export interface CallParsedArgs<Schema extends ZodType> {
  model: string;
  system: string;
  user: string;
  schema: Schema;
  maxTokens: number;
  logPrefix: string;
  // true のとき system プロンプトに cache_control=ephemeral を付ける
  cacheSystem?: boolean;
}

export async function callParsed<Schema extends ZodType>(
  args: CallParsedArgs<Schema>,
): Promise<ZodInfer<Schema>> {
  const client = getClient();
  const started = Date.now();

  // cacheSystem=true のとき system を cache_control 付きブロックとして送る
  // (string で渡すと cache_control を付けられない)
  const systemParam = args.cacheSystem
    ? [
        {
          type: 'text' as const,
          text: args.system,
          cache_control: { type: 'ephemeral' as const },
        },
      ]
    : args.system;

  const msg = await client.messages.parse({
    model: args.model,
    max_tokens: args.maxTokens,
    system: systemParam,
    messages: [{ role: 'user', content: args.user }],
    output_config: { format: zodOutputFormat(args.schema) },
  });
  const ms = Date.now() - started;

  const usage = msg.usage;
  // cache 統計は cacheSystem=true のときだけ追記。SDK 版によって型定義が未同期の
  // 可能性があるため unknown 経由で取り出す (cache_read_input_tokens / cache_creation_input_tokens)
  const anyUsage = usage as unknown as Record<string, number | undefined>;
  const cacheRead = anyUsage.cache_read_input_tokens ?? 0;
  const cacheWrite = anyUsage.cache_creation_input_tokens ?? 0;
  const cacheSuffix =
    args.cacheSystem && (cacheRead > 0 || cacheWrite > 0)
      ? ` cached_read=${cacheRead} cached_write=${cacheWrite}`
      : '';
  console.log(
    `${args.logPrefix} model=${args.model} in=${usage.input_tokens} out=${usage.output_tokens}${cacheSuffix} ${ms}ms`,
  );

  if (!msg.parsed_output) {
    throw new Error(`${args.logPrefix} parse failed: no parsed_output`);
  }
  return msg.parsed_output as ZodInfer<Schema>;
}
