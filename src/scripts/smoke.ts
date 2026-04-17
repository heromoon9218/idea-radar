// 認証不要なコレクタのスモークテスト
// 使い方: npx tsx src/scripts/smoke.ts

import { collectHatena } from '../collectors/hatena.js';
import { collectZenn } from '../collectors/zenn.js';
import { collectHackerNews } from '../collectors/hackernews.js';
import type { RawSignalInput } from '../types.js';

const WINDOW_MIN = 1440; // 過去24h

type SmokeCollector = readonly [string, () => Promise<RawSignalInput[]>];

async function main(): Promise<void> {
  const collectors: readonly SmokeCollector[] = [
    ['hatena', () => collectHatena(WINDOW_MIN)],
    ['zenn', () => collectZenn(WINDOW_MIN)],
    ['hackernews', () => collectHackerNews(WINDOW_MIN)],
  ];

  for (const [name, fn] of collectors) {
    const started = Date.now();
    try {
      const items = await fn();
      const ms = Date.now() - started;
      console.log(`[${name.padEnd(10)}] ok   count=${String(items.length).padStart(3)} ${ms}ms`);
      const sample = items[0];
      if (sample) {
        console.log(`  - title:     ${sample.title.slice(0, 80)}`);
        console.log(`  - posted_at: ${sample.posted_at}`);
        console.log(`  - url:       ${sample.url}`);
      }
    } catch (err) {
      const ms = Date.now() - started;
      console.error(`[${name.padEnd(10)}] FAIL ${ms}ms`, err);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
