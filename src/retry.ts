const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Error codes worth retrying: rate limits, server errors and transport failures. Client errors never are. */
export function isRetryableCode(code: string): boolean {
  return /^HTTP_(429|5\d\d)$/.test(code) || code === 'REQUEST_FAILED' || code === 'TIMEOUT';
}

/** Run `fn`, retrying errors flagged `retryable` with exponential backoff (1s, 2s, 4s). */
export async function retry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void> = wait, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const retryable = error instanceof Error && 'retryable' in error && error.retryable === true;
      if (!retryable || attempt >= attempts) throw error;
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}
