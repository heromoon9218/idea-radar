// Anthropic SDK v0.90: messages.parse + zodOutputFormat で構造化出力を 1 発で取る薄いラッパ。
// API キーは遅延初期化する。smoke (コレクタ単体) など LLM を呼ばない経路でも
// 本ファイルが transitively import されるため、トップレベル throw は回避。

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
}

export async function callParsed<Schema extends ZodType>(
  args: CallParsedArgs<Schema>,
): Promise<ZodInfer<Schema>> {
  const client = getClient();
  const started = Date.now();
  const msg = await client.messages.parse({
    model: args.model,
    max_tokens: args.maxTokens,
    system: args.system,
    messages: [{ role: 'user', content: args.user }],
    output_config: { format: zodOutputFormat(args.schema) },
  });
  const ms = Date.now() - started;

  const usage = msg.usage;
  console.log(
    `${args.logPrefix} model=${args.model} in=${usage.input_tokens} out=${usage.output_tokens} ${ms}ms`,
  );

  if (!msg.parsed_output) {
    throw new Error(`${args.logPrefix} parse failed: no parsed_output`);
  }
  return msg.parsed_output as ZodInfer<Schema>;
}
