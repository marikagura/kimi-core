import { describe, it, expect } from "vitest";
import { recurrenceMet, parseSweepVerdict } from "./concern-derive.js";

// The self-score concern gate (the actual "should this concern surface?" rule).
// Shipped thresholds: strong-negative <= -0.6 surfaces alone; weak negatives need
// >= 2 across >= 2 distinct days. Days are counted in the configured timezone
// (default Asia/Shanghai); the instants below are chosen so their local dates are
// unambiguous regardless of the exact offset.
const dayA = new Date("2026-06-10T04:00:00Z"); // 2026-06-10 local
const dayA2 = new Date("2026-06-10T10:00:00Z"); // same local day
const dayB = new Date("2026-06-12T04:00:00Z"); // 2026-06-12 local

const neg = (valence: number, createdAt: Date) => ({ valence, createdAt, validFrom: null });

describe("recurrenceMet — the self-score concern gate", () => {
  it("no negatives → not met", () => {
    expect(recurrenceMet([])).toBe(false);
  });

  it("a single strong negative surfaces immediately", () => {
    expect(recurrenceMet([neg(-0.7, dayA)])).toBe(true);
  });

  it("a single weak negative does not surface (count + days unmet)", () => {
    expect(recurrenceMet([neg(-0.3, dayA)])).toBe(false);
  });

  it("two weak negatives on the SAME day do not surface (days < 2)", () => {
    expect(recurrenceMet([neg(-0.3, dayA), neg(-0.4, dayA2)])).toBe(false);
  });

  it("two weak negatives across two days surface", () => {
    expect(recurrenceMet([neg(-0.3, dayA), neg(-0.3, dayB)])).toBe(true);
  });

  it("counts the day boundary by validFrom (event time) over createdAt", () => {
    // createdAt is the same day for both, but validFrom spans two days → surfaces.
    expect(
      recurrenceMet([
        { valence: -0.3, createdAt: dayA, validFrom: dayA },
        { valence: -0.3, createdAt: dayA, validFrom: dayB },
      ]),
    ).toBe(true);
  });
});

// The load-bearing invariant: a broken/garbled LLM response must NEVER produce
// "resolved" or "active" — either would silently close or reopen a concern.
describe("parseSweepVerdict — a misparse never closes or reopens a concern", () => {
  it("empty / whitespace → linger", () => {
    expect(parseSweepVerdict("").verdict).toBe("linger");
    expect(parseSweepVerdict("   ").verdict).toBe("linger");
  });
  it("prose with no JSON → linger (the word 'resolved' must not leak through)", () => {
    expect(parseSweepVerdict("the concern seems resolved to me").verdict).toBe("linger");
  });
  it("malformed / unclosed JSON → linger", () => {
    expect(parseSweepVerdict('{"verdict": "resolved"').verdict).toBe("linger");
  });
  it("unknown verdict value → linger (not echoed through)", () => {
    expect(parseSweepVerdict('{"verdict": "close it", "evidence": "x"}').verdict).toBe("linger");
  });
  it("valid resolved / active pass through, with evidence captured", () => {
    const r = parseSweepVerdict('{"verdict": "resolved", "evidence": "settled"}');
    expect(r.verdict).toBe("resolved");
    expect(r.evidenceNote).toBe("settled");
    expect(parseSweepVerdict('{"verdict": "active", "evidence": ""}').verdict).toBe("active");
  });
  it("valid linger passes through", () => {
    expect(parseSweepVerdict('{"verdict": "linger", "evidence": "still fading"}').verdict).toBe("linger");
  });
});
