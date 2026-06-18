// Shared retry wrapper for outbound HTTP. Retries transient network errors AND
// retryable HTTP statuses (429 / 5xx / 529) with exponential backoff + jitter,
// honoring Retry-After. A per-attempt timeout (default 60s) converts a mid-response
// hang into a retryable error instead of an indefinite stall — Node's global fetch
// has no response-body timeout, so without this a stalled keep-alive socket would
// wedge the caller (and any cron lock it holds) forever.
//
// Returns the final Response; callers MUST still check res.ok (a non-retryable 4xx,
// or a 429/5xx that survived all attempts, comes back as-is). Throws on exhausted
// network/timeout errors. See docs/PATTERNS.md §2.

function backoffMs(attempt: number): number {
  return 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 250); // exp + jitter
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h); // HTTP-date form
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (url: string) => url.slice(0, 60);

export async function fetchWithRetry(
  url: string,
  opts: any = {},
  maxAttempts = 3,
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let lastErr: any;
  for (let i = 0; i < maxAttempts; i++) {
    const last = i === maxAttempts - 1;
    // Per-attempt timeout. Combine with a caller-supplied signal when AbortSignal.any
    // is available (Node 20.3+); otherwise the timeout signal alone (no caller passes
    // one today).
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal =
      opts.signal && typeof (AbortSignal as any).any === "function"
        ? (AbortSignal as any).any([opts.signal, timeoutSignal])
        : opts.signal ?? timeoutSignal;
    try {
      const res = await fetch(url, { ...opts, signal });
      // Retryable HTTP statuses: 429 (rate limit), 5xx (server), 529 (overloaded).
      // 4xx (except 429) is the caller's bug — return it so res.ok handles it.
      if (!last && (res.status === 429 || res.status === 529 || res.status >= 500)) {
        const wait = retryAfterMs(res) ?? backoffMs(i);
        console.warn(`[fetch-retry] ${short(url)}... attempt ${i + 1} → HTTP ${res.status}, retry in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      return res;
    } catch (err: any) {
      lastErr = err;
      const code = err?.cause?.code;
      const name = err?.name;
      const transient =
        code === "ETIMEDOUT" ||
        code === "ECONNRESET" ||
        code === "ECONNREFUSED" ||
        code === "UND_ERR_CONNECT_TIMEOUT" ||
        name === "AbortError" ||
        name === "TimeoutError" || // AbortSignal.timeout fired
        name === "FetchError";
      if (!transient || last) throw err;
      const wait = backoffMs(i);
      console.warn(`[fetch-retry] ${short(url)}... attempt ${i + 1} failed (${code || name}), retry in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}
