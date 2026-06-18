import { describe, it, expect } from "vitest";
import { scoreRow, passesFilter } from "./retrieval.js";

// Pure scoring + the survivor filter — no DB. scoreMemories' SQL path needs
// Postgres, but the weighting math and the false-positive gate it feeds are
// deterministic and verified here without standing up a database.

describe("scoreRow — four-arm weighting (0.35 sem / 0.50 kw / 0.10 time / 0.05 imp)", () => {
  it("weights each signal and sums to final", () => {
    const r = scoreRow({ sem_sim: 1, kw_sim: 1, time_decay: 1, importance: 5 });
    expect(r.final).toBeCloseTo(1.0, 6); // .35 + .50 + .10 + (5/5)*.05
    expect(r.scoreBreakdown.semantic.contribution).toBeCloseTo(0.35, 6);
    expect(r.scoreBreakdown.keyword.contribution).toBeCloseTo(0.5, 6);
    expect(r.scoreBreakdown.time.contribution).toBeCloseTo(0.1, 6);
    expect(r.scoreBreakdown.importance.contribution).toBeCloseTo(0.05, 6);
  });
  it("defaults importance to 3/5 when absent", () => {
    expect(scoreRow({ sem_sim: 0, kw_sim: 0, time_decay: 0 }).final).toBeCloseTo((3 / 5) * 0.05, 6);
  });
  it("component toggle zeroes a signal's contribution", () => {
    const noSem = scoreRow({ sem_sim: 1, kw_sim: 1, time_decay: 0, importance: 3 }, { useSem: false });
    expect(noSem.sem).toBe(0);
    expect(noSem.scoreBreakdown.semantic.contribution).toBe(0);
    const noKw = scoreRow({ sem_sim: 1, kw_sim: 1, time_decay: 0, importance: 3 }, { useKw: false });
    expect(noKw.kw).toBe(0);
  });
  it("surfaces entity edges in the breakdown", () => {
    const r = scoreRow({ sem_sim: 0.5, kw_sim: 0, time_decay: 0, via_entity: true, entity_names: ["Jordan"] });
    expect(r.scoreBreakdown.entityHit).toBe(true);
    expect(r.entities).toEqual(["Jordan"]);
  });
});

describe("passesFilter — the false-positive gate (KW 0.3 / SEM_FLOOR 0.38 / final 0.2)", () => {
  const base = { kw: 0, via_entity: false, final: 0, sem: 0 };
  it("keeps a keyword hit at/above the floor regardless of sem", () => {
    expect(passesFilter({ ...base, kw: 0.3 })).toBe(true);
    expect(passesFilter({ ...base, kw: 0.29 })).toBe(false);
  });
  it("keeps an entity hit unconditionally", () => {
    expect(passesFilter({ ...base, via_entity: true })).toBe(true);
  });
  it("keeps a pure-semantic hit only above BOTH the final and sem floors", () => {
    expect(passesFilter({ ...base, final: 0.25, sem: 0.5 })).toBe(true);
    expect(passesFilter({ ...base, final: 0.25, sem: 0.37 })).toBe(false); // sem below SEM_FLOOR
    expect(passesFilter({ ...base, final: 0.1, sem: 0.5 })).toBe(false); // final below floor
  });
  it("rejects an unrelated low-signal row (the false positive it guards)", () => {
    expect(passesFilter({ ...base, kw: 0.1, sem: 0.2, final: 0.08 })).toBe(false);
  });
  it("a stricter (full-scope) final floor can be passed in", () => {
    expect(passesFilter({ ...base, final: 0.17, sem: 0.5 }, 0.15)).toBe(true); // full scope floor 0.15
  });
});
