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
//   * cohere → Cohere Rerank,  key COHERE_API_KEY  (e.g. rerank-multilingual-v3.0 / rerank-v3.5)
//   * jina   → Jina Reranker,  key JINA_API_KEY    (e.g. jina-reranker-v2-base-multilingual)
//   * voyage → Voyage Rerank,  key VOYAGE_API_KEY  (e.g. rerank-2, multilingual)
// For the API providers the model is set via RERANK_MODEL (no built-in default —
// fail-closed; unset → null). Pick a CJK-capable model. The API providers
// (cohere/jina/voyage) are paid AND ship the docs to a third party — prefer
// `local` for sensitive content. Unset/`none`/missing key/endpoint/model → null
// (no-op, graceful).
//
// Cross-encoder relevance lives on a different scale than cosine sim — callers
// must NOT feed these scores through the SEM_FLOOR / cosine-tuned gates. They
// are for re-RANKING an already-filtered candidate pool only.
// ============================================================================

import { fetchWithRetry } from "../fetch-retry.js";
import { errMessage } from "./err.js";

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
    const data = (await res.json()) as { scores?: unknown };
    const scores = data?.scores;
    if (!Array.isArray(scores) || scores.length !== docs.length) {
      console.error("[reranker] local unexpected response shape");
      return null;
    }
    return scores.map((s: unknown) => clamp01(Number(s)));
  } catch (err: unknown) {
    console.error("[reranker] local failed:", errMessage(err));
    return null;
  }
}

// Cloud rerank providers (Cohere / Jina / Voyage) — all POST /v1/rerank with the
// same shape, differing only in URL, the top-N body key, the results JSON path,
// and (Jina) an extra Accept header. Model comes from RERANK_MODEL (no built-in
// default — fail-closed; pick a CJK-capable model). relevance_score is in [0,1];
// scatterByIndex maps results back to input order (clamp01 guards downstream).
export const RERANK_CONFIGS = {
  cohere: { name: "cohere", url: "https://api.cohere.com/v1/rerank", topKey: "top_n", resultsPath: "results" },
  jina: { name: "jina", url: "https://api.jina.ai/v1/rerank", topKey: "top_n", resultsPath: "results", extraHeaders: { Accept: "application/json" } },
  voyage: { name: "voyage", url: "https://api.voyageai.com/v1/rerank", topKey: "top_k", resultsPath: "data" },
} as const;

type RerankConfig = (typeof RERANK_CONFIGS)[keyof typeof RERANK_CONFIGS];

export async function rerankViaApi(
  query: string,
  docs: string[],
  key: string,
  cfg: RerankConfig,
): Promise<number[] | null> {
  const model = (process.env.RERANK_MODEL || "").trim();
  if (!model) {
    console.warn("[reranker] RERANK_MODEL not set, skipping");
    return null;
  }
  try {
    const res = await fetchWithRetry(cfg.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...("extraHeaders" in cfg ? cfg.extraHeaders : {}),
      },
      body: JSON.stringify({ model, query, documents: docs, [cfg.topKey]: docs.length }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[reranker] ${cfg.name} ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as Record<string, unknown>;
    const results = data?.[cfg.resultsPath];
    if (!Array.isArray(results)) {
      console.error(`[reranker] ${cfg.name} unexpected response shape`);
      return null;
    }
    return scatterByIndex(
      results.map((r: { index: number; relevance_score: number }) => ({ index: r.index, score: Number(r.relevance_score) })),
      docs.length,
    );
  } catch (err: unknown) {
    console.error(`[reranker] ${cfg.name} failed:`, errMessage(err));
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
      return rerankViaApi(query, docs, key, RERANK_CONFIGS.cohere);
    }
    case "jina": {
      const key = process.env.JINA_API_KEY;
      if (!key) {
        console.warn("[reranker] JINA_API_KEY not set, skipping");
        return null;
      }
      return rerankViaApi(query, docs, key, RERANK_CONFIGS.jina);
    }
    case "voyage": {
      const key = process.env.VOYAGE_API_KEY;
      if (!key) {
        console.warn("[reranker] VOYAGE_API_KEY not set, skipping");
        return null;
      }
      return rerankViaApi(query, docs, key, RERANK_CONFIGS.voyage);
    }
  }
}
