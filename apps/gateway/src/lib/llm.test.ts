import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chatCompletion, callLLMShort } from "./llm.js";

// I1 — callLLM (intel) and callLLMShort (here) now share chatCompletion. These
// mock the global fetch (fetchWithRetry calls it) and pin the request shape +
// the load-bearing wrapper differences (chatCompletion returns content UNtrimmed;
// callLLMShort trims and defaults to a short max_tokens). No network / keys.
function mockFetch(content: string, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => "err-body",
  })) as any;
}
const bodyOf = (f: any) => JSON.parse(f.mock.calls[0][1].body);

describe("chatCompletion — shared OpenAI-compatible caller", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.LLM_BASE_URL = "https://x.test/v1";
    process.env.LLM_API_KEY = "k";
    process.env.KIMI_MODEL = "kimi-default";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("builds model + max_tokens + messages, and returns content UNtrimmed", async () => {
    const f = mockFetch("  raw output  ");
    globalThis.fetch = f;
    const out = await chatCompletion({ system: "s", user: "u", model: "m1", maxTokens: 1234 });
    const body = bodyOf(f);
    expect(body.model).toBe("m1");
    expect(body.max_tokens).toBe(1234);
    expect(body.messages).toEqual([{ role: "system", content: "s" }, { role: "user", content: "u" }]);
    expect(out).toBe("  raw output  "); // untrimmed — callers trim if they want
  });

  it("sends provider routing only when providerOrder is non-empty", async () => {
    const f1 = mockFetch("x"); globalThis.fetch = f1;
    await chatCompletion({ system: "s", user: "u", model: "m", maxTokens: 1, providerOrder: ["a", "b"] });
    expect(bodyOf(f1).provider).toEqual({ order: ["a", "b"], allow_fallbacks: true });

    const f2 = mockFetch("x"); globalThis.fetch = f2;
    await chatCompletion({ system: "s", user: "u", model: "m", maxTokens: 1, providerOrder: [] });
    expect(bodyOf(f2).provider).toBeUndefined();
  });

  it("sends reasoning only when thinkingTokens is set", async () => {
    const f1 = mockFetch("x"); globalThis.fetch = f1;
    await chatCompletion({ system: "s", user: "u", model: "m", maxTokens: 9, thinkingTokens: 4 });
    expect(bodyOf(f1).reasoning).toEqual({ max_tokens: 4 });

    const f2 = mockFetch("x"); globalThis.fetch = f2;
    await chatCompletion({ system: "s", user: "u", model: "m", maxTokens: 9 });
    expect(bodyOf(f2).reasoning).toBeUndefined();
  });

  it("throws `LLM <status>` on a non-ok (non-retryable) response", async () => {
    globalThis.fetch = mockFetch("x", false, 400); // 400 isn't retried → surfaces immediately
    await expect(chatCompletion({ system: "s", user: "u", model: "m", maxTokens: 1 })).rejects.toThrow(/LLM 400/);
  });
});

describe("callLLMShort — short wrapper trims and defaults max_tokens=200", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.LLM_BASE_URL = "https://x.test/v1";
    process.env.LLM_API_KEY = "k";
    process.env.KIMI_MODEL = "kimi-default";
    delete process.env.LLM_SHORT_MODEL;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("trims the result and uses the short default max_tokens", async () => {
    const f = mockFetch("  hello  ");
    globalThis.fetch = f;
    const out = await callLLMShort("s", "u");
    expect(out).toBe("hello"); // trimmed (the difference from chatCompletion)
    expect(bodyOf(f).max_tokens).toBe(200);
    expect(bodyOf(f).model).toBe("kimi-default"); // LLM_SHORT_MODEL unset → KIMI_MODEL
  });

  it("honours an explicit model + maxTokens override", async () => {
    const f = mockFetch("ok");
    globalThis.fetch = f;
    await callLLMShort("s", "u", { model: "m2", maxTokens: 50 });
    expect(bodyOf(f).model).toBe("m2");
    expect(bodyOf(f).max_tokens).toBe(50);
  });
});
