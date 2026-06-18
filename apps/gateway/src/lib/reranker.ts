// ============================================================================
// Cross-encoder reranker — provider-agnostic relevance scoring.
//
// `rerankCandidates(query, docs)` returns one relevance score in [0,1] per doc,
// in the SAME order as the input `docs`, or `null` when reranking is unavailable
// (no provider configured / no key / HTTP failure / unexpected response). A null
// return is the graceful-degrade signal — callers fall back to hybrid order, so
// the default rerank=off path and any keyless deploy stay byte-identical.
//
// Mirrors embed.ts's contract: env-gated, returns null instead of throwing, so
// the live tool never breaks because a rerank key is missing.
//
// Provider is selected by RERANK_PROVIDER (local | cohere | jina | voyage | none).
//   * local  → self-hosted cross-encoder (bge-reranker-v2-m3). Free, no key, and
//              memory text never leaves the box, so it is not sent to a third
//              party for sensitive content. Endpoint RERANK_LOCAL_URL
//              (default http://127.0.0.1:8787/rerank).
//   * cohere → Cohere Rerank (rerank-multilingual-v3.0 / rerank-v3.5), key COHERE_API_KEY
//   * jina   → jina-reranker-v2-base-multilingual,                 key JINA_API_KEY
//   * voyage → Voyage rerank-2 (multilingual),                     key VOYAGE_API_KEY
// All handle CJK. The API providers (cohere/jina/voyage) are paid AND ship the
// docs to a third party — prefer `local` for sensitive content. Unset/`none`/
// missing key/endpoint → null (no-op, graceful).
//
// Cross-encoder relevance lives on a different scale than cosine sim — callers
// must NOT feed these scores through the SEM_FLOOR / cosine-tuned gates. They
// are for re-RANKING an already-filtered candidate pool only.
// ============================================================================

import { fetchWithRetry } from "../fetch-retry.js";

type Provider = "local" | "cohere" | "jina" | "voyage" | "none";

function resolveProvider(): Provider {
  const p = (process.env.RERANK_PROVIDER || "none").trim().toLowerCase();
  if (p === "local" || p === "cohere" || p === "jina" || p === "voyage") return p;
  return "none";
}

// Clamp a provider's relevance score into [0,1]. Cohere/Jina already return
// normalized [0,1] relevance; this is a defensive cap in case a provider/model
// ever returns out-of-range (e.g. Voyage logit-style) so downstream weighting
// stays well-behaved.
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// Re-order a provider's {index, score} results back into input order. Providers
// may return results sorted by relevance (Cohere/Voyage) or omit some indices;
// we map by index and default any missing doc to 0 so the output length always
// equals docs.length and aligns positionally with the caller's candidate array.
function scatterByIndex(
  results: Array<{ index: number; score: number }>,
  n: number,
): number[] {
  const out = new Array<number>(n).fill(0);
  for (const r of results) {
    if (typeof r.index === "number" && r.index >= 0 && r.index < n) {
      out[r.index] = clamp01(r.score);
    }
  }
  return out;
}

// Local cross-encoder — POST RERANK_LOCAL_URL with {query, documents}. The
// server returns {scores: number[]} already aligned to input order and
// sigmoid-normalized to [0,1], so no index scatter is needed. No key, no
// third-party egress. Any failure / shape mismatch → null (graceful).
async function rerankLocal(query: string, docs: string[]): Promise<number[] | null> {
  const url = process.env.RERANK_LOCAL_URL || "http://127.0.0.1:8787/rerank";
  try {
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, documents: docs }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[reranker] local ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data: any = await res.json();
    const scores = data?.scores;
    if (!Array.isArray(scores) || scores.length !== docs.length) {
      console.error("[reranker] local unexpected response shape");
      return null;
    }
    return scores.map((s: any) => clamp01(Number(s)));
  } catch (err: any) {
    console.error("[reranker] local failed:", err?.message || err);
    return null;
  }
}

// Cohere Rerank — POST /v1/rerank. Model defaults to rerank-multilingual-v3.0
// (CJK-capable); override via RERANK_MODEL (e.g. rerank-v3.5). Response:
// { results: [{ index, relevance_score }, ...] } sorted by relevance.
async function rerankCohere(
  query: string,
  docs: string[],
  key: string,
): Promise<number[] | null> {
  const model = process.env.RERANK_MODEL || "rerank-multilingual-v3.0";
  try {
    const res = await fetchWithRetry("https://api.cohere.com/v1/rerank", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        query,
        documents: docs,
        top_n: docs.length,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[reranker] cohere ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data: any = await res.json();
    const results = data?.results;
    if (!Array.isArray(results)) {
      console.error("[reranker] cohere unexpected response shape");
      return null;
    }
    return scatterByIndex(
      results.map((r: any) => ({ index: r.index, score: Number(r.relevance_score) })),
      docs.length,
    );
  } catch (err: any) {
    console.error("[reranker] cohere failed:", err?.message || err);
    return null;
  }
}

// Jina Reranker — POST /v1/rerank. Model defaults to
// jina-reranker-v2-base-multilingual (CJK-capable). Response:
// { results: [{ index, relevance_score }, ...] }.
async function rerankJina(
  query: string,
  docs: string[],
  key: string,
): Promise<number[] | null> {
  const model = process.env.RERANK_MODEL || "jina-reranker-v2-base-multilingual";
  try {
    const res = await fetchWithRetry("https://api.jina.ai/v1/rerank", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model,
        query,
        documents: docs,
        top_n: docs.length,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[reranker] jina ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data: any = await res.json();
    const results = data?.results;
    if (!Array.isArray(results)) {
      console.error("[reranker] jina unexpected response shape");
      return null;
    }
    return scatterByIndex(
      results.map((r: any) => ({ index: r.index, score: Number(r.relevance_score) })),
      docs.length,
    );
  } catch (err: any) {
    console.error("[reranker] jina failed:", err?.message || err);
    return null;
  }
}

// Voyage Reranker — POST /v1/rerank. Model defaults to rerank-2 (multilingual).
// Response: { data: [{ index, relevance_score }, ...] }. relevance_score is in
// [0,1]; clamp01 guards regardless.
async function rerankVoyage(
  query: string,
  docs: string[],
  key: string,
): Promise<number[] | null> {
  const model = process.env.RERANK_MODEL || "rerank-2";
  try {
    const res = await fetchWithRetry("https://api.voyageai.com/v1/rerank", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        query,
        documents: docs,
        top_k: docs.length,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[reranker] voyage ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data: any = await res.json();
    const results = data?.data;
    if (!Array.isArray(results)) {
      console.error("[reranker] voyage unexpected response shape");
      return null;
    }
    return scatterByIndex(
      results.map((r: any) => ({ index: r.index, score: Number(r.relevance_score) })),
      docs.length,
    );
  } catch (err: any) {
    console.error("[reranker] voyage failed:", err?.message || err);
    return null;
  }
}

// Public entry. Returns one relevance score in [0,1] per doc (input order), or
// null when reranking is unavailable (no provider / no key / failure). Empty
// docs short-circuits to [] (a valid, non-null "nothing to rerank" result).
export async function rerankCandidates(
  query: string,
  docs: string[],
): Promise<number[] | null> {
  if (!query || query.trim().length === 0) return null;
  if (docs.length === 0) return [];

  const provider = resolveProvider();
  if (provider === "none") {
    console.warn("[reranker] RERANK_PROVIDER not set, skipping");
    return null;
  }

  switch (provider) {
    case "local":
      // No key — the endpoint itself is the gate (RERANK_LOCAL_URL or default).
      return rerankLocal(query, docs);
    case "cohere": {
      const key = process.env.COHERE_API_KEY;
      if (!key) {
        console.warn("[reranker] COHERE_API_KEY not set, skipping");
        return null;
      }
      return rerankCohere(query, docs, key);
    }
    case "jina": {
      const key = process.env.JINA_API_KEY;
      if (!key) {
        console.warn("[reranker] JINA_API_KEY not set, skipping");
        return null;
      }
      return rerankJina(query, docs, key);
    }
    case "voyage": {
      const key = process.env.VOYAGE_API_KEY;
      if (!key) {
        console.warn("[reranker] VOYAGE_API_KEY not set, skipping");
        return null;
      }
      return rerankVoyage(query, docs, key);
    }
  }
}
