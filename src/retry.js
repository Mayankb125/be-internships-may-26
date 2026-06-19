function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `fn` up to `maxAttempts` times with exponential backoff + jitter.
 * `shouldRetry(err)` lets the caller decide which errors are worth
 * retrying — e.g. a UNIQUE constraint conflict is NOT transient and
 * should be handled immediately by the caller, not retried.
 */
export async function retry(fn, { maxAttempts = 3, baseDelayMs = 25, shouldRetry = () => true } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === maxAttempts || !shouldRetry(e)) break;

      const backoff = baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = Math.random() * baseDelayMs;
      await sleep(backoff + jitter);
    }
  }
  throw lastErr;
}