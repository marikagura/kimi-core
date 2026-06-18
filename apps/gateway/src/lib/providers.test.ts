import { describe, it, expect, vi, afterEach } from "vitest";
import { getNotifier, getSearchProvider, WebhookNotifier, HttpSearchProvider, ConsoleNotifier, mapResults } from "./providers.js";

const ENV = ["NOTIFIER", "NOTIFIER_WEBHOOK_URL", "NOTIFIER_WEBHOOK_FIELD", "SEARCH_PROVIDER", "SEARCH_API_URL", "SEARCH_API_KEY", "SEARCH_QUERY_PARAM", "SEARCH_RESULTS_PATH", "SEARCH_FIELD_TITLE", "SEARCH_FIELD_URL", "SEARCH_FIELD_SNIPPET"];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  vi.unstubAllGlobals();
});

describe("getNotifier — env selection + safe fallback", () => {
  it("defaults to the console notifier (no-op-equivalent)", () => {
    expect(getNotifier()).toBe(ConsoleNotifier);
  });
  it("webhook without a URL falls back to console", () => {
    process.env.NOTIFIER = "webhook";
    expect(getNotifier()).toBe(ConsoleNotifier);
  });
  it("webhook with a URL returns a WebhookNotifier", () => {
    process.env.NOTIFIER = "webhook";
    process.env.NOTIFIER_WEBHOOK_URL = "https://example.test/hook";
    expect(getNotifier()).toBeInstanceOf(WebhookNotifier);
  });
});

describe("WebhookNotifier.send — posts the mapped body", () => {
  it("POSTs JSON with content under the configured field", async () => {
    const fetchMock = vi.fn(async (_url: string, _opts: any) => ({ ok: true, status: 200 }) as any);
    vi.stubGlobal("fetch", fetchMock);
    await new WebhookNotifier("https://example.test/hook", "text").send({ content: "hello", slug: "wake-1", priority: "high" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe("https://example.test/hook");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({ text: "hello", slug: "wake-1", priority: "high" });
  });
  it("does not throw when the endpoint fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(new WebhookNotifier("https://x.test").send({ content: "c", slug: "s" })).resolves.toBeUndefined();
  });
});

describe("mapResults — configurable result mapping", () => {
  it("maps the default {results:[{title,url,snippet}]} shape", () => {
    const out = mapResults({ results: [{ title: "T", url: "https://u", snippet: "S" }] });
    expect(out).toEqual([{ title: "T", url: "https://u", snippet: "S" }]);
  });
  it("honors a nested path + custom field names", () => {
    process.env.SEARCH_RESULTS_PATH = "data.web";
    process.env.SEARCH_FIELD_TITLE = "name";
    process.env.SEARCH_FIELD_SNIPPET = "desc";
    const out = mapResults({ data: { web: [{ name: "N", desc: "D" }] } });
    expect(out).toEqual([{ title: "N", url: undefined, snippet: "D" }]);
  });
  it("returns [] when the path isn't an array", () => {
    expect(mapResults({ results: "nope" })).toEqual([]);
    expect(mapResults({})).toEqual([]);
  });
  it("drops empty entries (no title and no snippet)", () => {
    expect(mapResults({ results: [{ title: "", snippet: "" }, { title: "keep", snippet: "" }] })).toHaveLength(1);
  });
});

describe("getSearchProvider + HttpSearchProvider", () => {
  it("defaults to the no-op provider", () => {
    expect(getSearchProvider().name).toBe("noop");
  });
  it("http without a URL stays no-op", () => {
    process.env.SEARCH_PROVIDER = "http";
    expect(getSearchProvider().name).toBe("noop");
  });
  it("http with a URL returns the HTTP provider", () => {
    process.env.SEARCH_PROVIDER = "http";
    process.env.SEARCH_API_URL = "https://search.test/api";
    expect(getSearchProvider()).toBeInstanceOf(HttpSearchProvider);
  });
  it("HttpSearchProvider.search hits the API and maps results", async () => {
    process.env.SEARCH_API_URL = "https://search.test/api";
    process.env.SEARCH_API_KEY = "k";
    const fetchMock = vi.fn(async (_url: string, _opts: any) => ({ ok: true, status: 200, json: async () => ({ results: [{ title: "T", url: "https://u", snippet: "S" }] }) }) as any);
    vi.stubGlobal("fetch", fetchMock);
    const out = await new HttpSearchProvider().search("pgvector tuning");
    expect(out).toEqual([{ title: "T", url: "https://u", snippet: "S" }]);
    const [url, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toContain("q=pgvector%20tuning");
    expect(opts.headers.authorization).toBe("Bearer k");
  });
});
