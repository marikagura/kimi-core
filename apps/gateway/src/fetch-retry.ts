// Shared retry wrapper for transient network errors (ETIMEDOUT / AbortError / etc.).
export async function fetchWithRetry(url: string, opts: any = {}, maxAttempts = 3): Promise<Response> {
  let lastErr: any;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fetch(url, opts);
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
        name === "FetchError";
      if (!transient) throw err;
      if (i < maxAttempts - 1) {
        const delay = 1000 * Math.pow(2, i);
        console.warn(`[fetch-retry] ${url.slice(0, 60)}... attempt ${i + 1} failed (${code || name}), retry in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}
