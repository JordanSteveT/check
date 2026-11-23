// Calls between Durable Objects can fail transiently (object reset, overloaded, code update):
// Cloudflare marks such errors as retryable (`retryable: true`) or asks to retry the call.

function isRetryable(err: unknown): boolean {
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { retryable?: unknown }).retryable === true
  ) {
    return true;
  }
  return String(err).includes("retry");
}

/** Runs `call` (which must create a fresh stub each time), retrying a retryable failure. */
export async function withRetry<T>(call: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= attempts || !isRetryable(err)) throw err;
    }
  }
}
