import { describe, it, expect } from "vitest";
import { matches, dcg, ndcgAt10, coverageOf, mrr, meanNdcg, evalCase, pct, regressionDrop, type Hit, type CaseEval } from "./run.js";

// Pure metric math — no DB. The harness's scoreMemories path needs Postgres, but
// the metrics it feeds are deterministic and unit-tested here, so a regression in
// hit@k / MRR / nDCG / set-recall is caught without standing up a database.

const hit = (id: string, text: string): Hit => ({
  id,
  title: text,
  summary: null,
  content: "",
  final: 0,
  sem: 0,
  kw: 0,
  via_entity: false,
});

describe("matches — case-insensitive, any-keyword, across fields", () => {
  it("matches a keyword in title", () => {
    expect(matches(hit("a", "Helios roadmap"), ["helios"])).toBe(true);
  });
  it("matches in summary or content too", () => {
    const h: Hit = { ...hit("a", "untitled"), summary: "about POUR-OVER", content: "deep work" };
    expect(matches(h, ["pour-over"])).toBe(true);
    expect(matches(h, ["deep work"])).toBe(true);
  });
  it("misses when no keyword present", () => {
    expect(matches(hit("a", "rock climbing"), ["sonar"])).toBe(false);
  });
});

describe("dcg / nDCG@10", () => {
  it("dcg discounts by log2(rank+1)", () => {
    expect(dcg([1])).toBeCloseTo(1, 6); // rank 1 → /log2(2)=1
    expect(dcg([0, 1])).toBeCloseTo(1 / Math.log2(3), 6); // rank 2
  });
  it("all relevant at the top → 1.0", () => {
    const hits = [hit("1", "helios"), hit("2", "helios"), hit("3", "x")];
    expect(ndcgAt10(hits, ["helios"])).toBeCloseTo(1, 6);
  });
  it("relevant pushed to the bottom → < 1", () => {
    const hits = [hit("1", "x"), hit("2", "y"), hit("3", "helios")];
    expect(ndcgAt10(hits, ["helios"])).toBeLessThan(1);
    expect(ndcgAt10(hits, ["helios"])).toBeGreaterThan(0);
  });
  it("no relevant doc → 0", () => {
    expect(ndcgAt10([hit("1", "x")], ["helios"])).toBe(0);
  });
});

describe("evalCase — hit@5 / hit@10 / rank, and expectNone control", () => {
  it("first relevant at rank 3 → hit@5 and hit@10", () => {
    const hits = [hit("1", "x"), hit("2", "y"), hit("3", "helios"), hit("4", "z")];
    const e = evalCase({ kind: "k", query: "q", expectKeywords: ["helios"] }, hits);
    expect(e.firstMatchRank).toBe(3);
    expect(e.hitAt5).toBe(true);
    expect(e.hitAt10).toBe(true);
    expect(e.pass).toBe(true);
  });
  it("first relevant at rank 7 → hit@10 but not hit@5", () => {
    const hits = Array.from({ length: 8 }, (_, i) => hit(String(i), i === 6 ? "helios" : "x"));
    const e = evalCase({ kind: "k", query: "q", expectKeywords: ["helios"] }, hits);
    expect(e.firstMatchRank).toBe(7);
    expect(e.hitAt5).toBe(false);
    expect(e.hitAt10).toBe(true);
  });
  it("expectNone passes only on empty results", () => {
    expect(evalCase({ kind: "neg", query: "q", expectNone: true }, []).pass).toBe(true);
    expect(evalCase({ kind: "neg", query: "q", expectNone: true }, [hit("1", "x")]).pass).toBe(false);
  });
});

describe("mrr / meanNdcg aggregates", () => {
  const mk = (rank: number, ndcg = 1, expectNone = false): CaseEval => ({
    case: { kind: "k", query: "q", expectNone },
    hits: [],
    firstMatchRank: rank,
    hitAt5: rank >= 1 && rank <= 5,
    hitAt10: rank >= 1 && rank <= 10,
    pass: rank >= 1 && rank <= 10,
    ndcgAt10: ndcg,
  });
  it("MRR = mean of reciprocal first-ranks (0 for misses)", () => {
    expect(mrr([mk(1), mk(2), mk(0)])).toBeCloseTo((1 + 0.5 + 0) / 3, 6);
  });
  it("meanNdcg excludes expectNone cases", () => {
    expect(meanNdcg([mk(1, 1), mk(1, 0.5), mk(0, 0, true)])).toBeCloseTo((1 + 0.5) / 2, 6);
  });
});

describe("coverageOf — set-recall@K", () => {
  it("covers a member if SOME returned doc matches it", () => {
    const hits = [hit("1", "Mochi the cat"), hit("2", "something else")];
    const cov = coverageOf(hits, [["cat", "Mochi"], ["dog", "Rufus"]]);
    expect(cov.members).toBe(2);
    expect(cov.covered).toBe(1);
    expect(cov.coverage).toBeCloseTo(0.5, 6);
    expect(cov.missing).toEqual(["dog"]);
  });
  it("full coverage when all members present", () => {
    const hits = [hit("1", "cat Mochi"), hit("2", "dog Rufus")];
    expect(coverageOf(hits, [["cat"], ["dog"]]).coverage).toBe(1);
  });
});

describe("regressionDrop", () => {
  it("returns avg(baseline) - current", () => {
    expect(regressionDrop(80, [90, 90, 90])).toBeCloseTo(10, 6);
  });
  it("no baseline → 0", () => {
    expect(regressionDrop(80, [])).toBe(0);
  });
});

describe("pct", () => {
  it("guards divide-by-zero", () => {
    expect(pct(0, 0)).toBe(0);
    expect(pct(3, 4)).toBe(75);
  });
});
