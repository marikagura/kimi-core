import { describe, it, expect } from "vitest";
import { groupByIdleGap } from "./session-group.js";

// Pure unit test (I2) — no DB. Pins the session-boundary rule, including the
// load-bearing `> gap` (strictly greater) vs `>=`: a gap of exactly gapH stays in
// the same session. Times are fixed offsets from a constant base (no Date.now()).
const base = new Date("2026-01-01T00:00:00Z").getTime();
const H = 3600 * 1000;
const at = (ms: number, id: string) => ({ id, createdAt: new Date(base + ms) });
const shape = (g: { id: string }[][]) => g.map((s) => s.map((e) => e.id));

describe("groupByIdleGap", () => {
  it("returns no sessions for no events", () => {
    expect(groupByIdleGap([], 4)).toEqual([]);
  });

  it("puts a single event in its own session", () => {
    expect(shape(groupByIdleGap([at(0, "a")], 4))).toEqual([["a"]]);
  });

  it("keeps events closer than the gap in one session", () => {
    const g = groupByIdleGap([at(0, "a"), at(3 * H, "b"), at(5 * H, "c")], 4); // 3h then 2h
    expect(shape(g)).toEqual([["a", "b", "c"]]);
  });

  it("splits when a gap exceeds gapH", () => {
    const g = groupByIdleGap([at(0, "a"), at(4 * H + 1, "b")], 4); // just over 4h
    expect(shape(g)).toEqual([["a"], ["b"]]);
  });

  it("treats a gap of exactly gapH as the same session (boundary: > not >=)", () => {
    const g = groupByIdleGap([at(0, "a"), at(4 * H, "b")], 4); // exactly 4h
    expect(shape(g)).toEqual([["a", "b"]]);
  });

  it("handles multiple sessions with mixed gaps", () => {
    const g = groupByIdleGap(
      [at(0, "a"), at(1 * H, "b"), at(10 * H, "c"), at(11 * H, "d"), at(20 * H, "e")],
      4,
    );
    expect(shape(g)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });
});
