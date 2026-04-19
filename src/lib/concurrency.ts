// Promise の同時実行数を上限 limit で制限する軽量 map。
// 依存追加を避けるため p-limit 等の外部ライブラリではなく自前実装。
// Promise.allSettled と同じ semantics で、1 件の失敗が全体を落とさない。
//
// 用途: Sonnet × 3 役割ドラフトの並列発火を絞る。
// - Anthropic API のレート制限 (RPM / ITPM) を回避する保険
// - prompt caching (ephemeral) の書き込み→読み取りフローを成立させるため逐次寄りにする

export async function mapWithLimit<I, O>(
  items: readonly I[],
  limit: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<PromiseSettledResult<O>[]> {
  if (limit < 1) throw new Error(`mapWithLimit: limit must be >= 1 (got ${limit})`);
  if (items.length === 0) return [];

  // 全 index を最終的に埋める前提だが、noUncheckedIndexedAccess 下での型安全のため
  // 初期値を置いておく (未実行のまま残ることは設計上起きない)。
  const results: PromiseSettledResult<O>[] = Array.from({ length: items.length }, () => ({
    status: 'rejected',
    reason: new Error('mapWithLimit: slot not filled (internal bug)'),
  }));

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      const item = items[i]!;
      try {
        const value = await fn(item, i);
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
