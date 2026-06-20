import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rerankViaApi, RERANK_CONFIGS } from "./reranker.js";

// The cloud-provider fold (R3) collapsed three near-identical functions into one.
// These mock the global fetch (which fetchWithRetry calls) and assert the fold
// preserves each provider's LOAD-BEARING differences — URL, top_n vs top_k, Jina's
// Accept header, and the results-vs-data JSON path — without any real network/keys.
function mockFetch(responseBody: any) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => responseBody,
    text: async () => JSON.stringify(responseBody),
  })) as any;
}

describe("rerankViaApi — the cloud-provider fold preserves each provider's request shape", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.RERANK_MODEL = "test-rerank-model";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("cohere: cohere URL, top_n, no Accept header, reads data.results", async () => {
    const f = mockFetch({ results: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.1 }] });
    globalThis.fetch = f;
    const out = await rerankViaApi("q", ["a", "b"], "k", RERANK_CONFIGS.cohere);
    const [url, opts] = f.mock.calls[0];
    expect(url).toBe("https://api.cohere.com/v1/rerank");
    const body = JSON.parse(opts.body);
    expect(body.top_n).toBe(2);
    expect(body.top_k).toBeUndefined();
    expect(opts.headers.Accept).toBeUndefined();
    expect(out).toEqual([0.9, 0.1]);
  });

  it("jina: jina URL, top_n, Accept header present, reads data.results", async () => {
    const f = mockFetch({ results: [{ index: 0, relevance_score: 0.7 }, { index: 1, relevance_score: 0.2 }] });
    globalThis.fetch = f;
    const out = await rerankViaApi("q", ["a", "b"], "k", RERANK_CONFIGS.jina);
    const [url, opts] = f.mock.calls[0];
    expect(url).toBe("https://api.jina.ai/v1/rerank");
    expect(opts.headers.Accept).toBe("application/json");
    expect(JSON.parse(opts.body).top_n).toBe(2);
    expect(out).toEqual([0.7, 0.2]);
  });

  it("voyage: voyage URL, top_k (not top_n), no Accept, reads data.data", async () => {
    const f = mockFetch({ data: [{ index: 1, relevance_score: 0.8 }, { index: 0, relevance_score: 0.3 }] });
    globalThis.fetch = f;
    const out = await rerankViaApi("q", ["a", "b"], "k", RERANK_CONFIGS.voyage);
    const [url, opts] = f.mock.calls[0];
    expect(url).toBe("https://api.voyageai.com/v1/rerank");
    const body = JSON.parse(opts.body);
    expect(body.top_k).toBe(2);
    expect(body.top_n).toBeUndefined();
    expect(opts.headers.Accept).toBeUndefined();
    // results come back out of order (index 1 then 0) → scattered into input order
    expect(out).toEqual([0.3, 0.8]);
  });

  it("fails closed (returns null, no call) when RERANK_MODEL is unset", async () => {
    delete process.env.RERANK_MODEL;
    const f = mockFetch({ results: [] });
    globalThis.fetch = f;
    const out = await rerankViaApi("q", ["a"], "k", RERANK_CONFIGS.cohere);
    expect(out).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
