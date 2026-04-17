// 一時的な障害（5xx / ネットワークエラー）に対して指数バックオフでリトライする fetch ラッパ。
// 4xx は恒久的エラーとみなしリトライしない。

export interface FetchRetryOptions {
  retries?: number;
  baseDelayMs?: number;
  // リトライ試行ごとに呼ばれる（ログ用）
  onRetry?: (info: { attempt: number; error: unknown; url: string }) => void;
}

const DEFAULT_RETRIES = 2; // 初回含めて最大 3 回試行
const DEFAULT_BASE_DELAY_MS = 500;

function isRetriableStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  input: string,
  init?: RequestInit,
  options: FetchRetryOptions = {},
): Promise<Response> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const baseDelay = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(input, init);
      if (res.ok) return res;
      if (!isRetriableStatus(res.status) || attempt === retries) {
        return res;
      }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
      if (attempt === retries) throw err;
    }

    options.onRetry?.({ attempt: attempt + 1, error: lastError, url: input });
    // 指数バックオフ: 500ms → 1000ms → 2000ms
    await sleep(baseDelay * 2 ** attempt);
  }

  // 到達不可（ループ内で必ず return or throw する）
  throw lastError ?? new Error('fetchWithRetry: unreachable');
}
