import { describe, it, expect, vi, afterEach } from "vitest";
import { pubMedAdapter } from "./source.js";

// Unit test (no network / DB) — mocks global fetch (fetchWithRetry calls it) and
// pins the PubMed adapter's parse: esearch idlist → esummary → PaperHit[], plus
// the journal whitelist filter. CI-safe.
function mockFetch(map: { esearch: any; esummary: any }) {
  return vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes("esearch") ? map.esearch : map.esummary),
  })) as any;
}

describe("pubMedAdapter", () => {
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
    vi.restoreAllMocks();
  });

  it("parses esearch idlist → esummary → PaperHit[]", async () => {
    globalThis.fetch = mockFetch({
      esearch: { esearchresult: { idlist: ["111", "222"] } },
      esummary: {
        result: {
          "111": { uid: "111", title: "Paper A", fulljournalname: "Nature", authors: [{ name: "Doe J" }], pubdate: "2026 Jun 1" },
          "222": { uid: "222", title: "Paper B", source: "Cell", authors: [], pubdate: "2026 Jun 2" },
        },
      },
    });
    const hits = await pubMedAdapter({ query: "x" }).fetchRecent();
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      externalId: "111",
      title: "Paper A",
      journal: "Nature",
      url: "https://pubmed.ncbi.nlm.nih.gov/111/",
      authors: "Doe J",
    });
    expect(hits[1].journal).toBe("Cell"); // falls back to `source` when no fulljournalname
  });

  it("empty idlist → [] (no esummary call needed)", async () => {
    globalThis.fetch = mockFetch({ esearch: { esearchresult: { idlist: [] } }, esummary: {} });
    expect(await pubMedAdapter({ query: "x" }).fetchRecent()).toEqual([]);
  });

  it("journalWhitelist keeps only matching journals (case-insensitive substring)", async () => {
    globalThis.fetch = mockFetch({
      esearch: { esearchresult: { idlist: ["1", "2"] } },
      esummary: {
        result: {
          "1": { uid: "1", title: "A", fulljournalname: "Nature Medicine" },
          "2": { uid: "2", title: "B", fulljournalname: "Some Other Journal" },
        },
      },
    });
    const hits = await pubMedAdapter({ query: "x", journalWhitelist: ["nature"] }).fetchRecent();
    expect(hits.map((h) => h.externalId)).toEqual(["1"]);
  });
});
