import { describe, it, expect } from "vitest";
import { computeDataStatus } from "./sleep-concern.js";
import { slugify, recalibrateValence } from "./concern-derive.js";
import { toVectorLiteral } from "./embed.js";

const TH = { weeklyAvg: 7, shortValue: 4, shortCount: 2 };

describe("computeDataStatus (data-driven concern state machine)", () => {
  it("returns insufficient_data below 3 windows", () => {
    const r = computeDataStatus([{ value: 5 }, { value: 5 }], TH);
    expect(r.concerned).toBe(false);
    expect(r.status).toBe("RESOLVED");
    expect(r.reason).toBe("insufficient_data");
  });

  it("RESOLVED when average healthy and no short windows", () => {
    const r = computeDataStatus([{ value: 7 }, { value: 8 }, { value: 7 }], TH);
    expect(r.concerned).toBe(false);
    expect(r.status).toBe("RESOLVED");
  });

  it("OPEN when average below threshold", () => {
    const r = computeDataStatus([{ value: 3 }, { value: 3 }, { value: 3 }], TH);
    expect(r.concerned).toBe(true);
    expect(r.status).toBe("OPEN");
  });

  it("EASING when short-driven but most recent window recovered", () => {
    // avg = (3+3+16)/3 = 7.33 >= 7 (not avgLow); 2 short windows (>= shortCount);
    // most recent (16) >= shortValue → recovering → EASING
    const r = computeDataStatus([{ value: 3 }, { value: 3 }, { value: 16 }], TH);
    expect(r.concerned).toBe(true);
    expect(r.status).toBe("EASING");
  });
});

describe("slugify (concernKey slug)", () => {
  it("lowercases and underscores", () => expect(slugify("Hello World")).toBe("hello_world"));
  it("falls back to untitled on empty", () => expect(slugify("  ")).toBe("untitled"));
  it("preserves CJK characters", () => expect(slugify("记忆 test")).toBe("记忆_test"));
  it("truncates to 24 chars", () => expect(slugify("a".repeat(40)).length).toBeLessThanOrEqual(24));
});

describe("recalibrateValence (monotone user-feedback calibration)", () => {
  it("is identity below the minimum sample count", () => {
    expect(recalibrateValence(0.5, [{ self: 0.2, user: 0.4 }])).toBe(0.5);
  });
  it("applies the mean (user - self) offset and clamps to [-1, 1]", () => {
    const samples = Array.from({ length: 10 }, () => ({ self: 0, user: 0.3 }));
    expect(recalibrateValence(0.5, samples)).toBeCloseTo(0.8);
    expect(recalibrateValence(0.9, samples)).toBe(1); // clamp
  });
});

describe("toVectorLiteral (pgvector literal)", () => {
  it("formats a Float[] as a bracketed literal", () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe("[0.1,0.2,0.3]");
  });
});
