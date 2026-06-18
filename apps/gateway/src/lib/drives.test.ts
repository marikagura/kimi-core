import { describe, it, expect, afterEach } from "vitest";
import { foldDim, shapeOpts, loadDriveDefs, type DriveShape } from "./concern-derive.js";

// Pure drive math + roster loading — no DB. Verifies the four SEEKING shapes
// actually produce different wanting curves (so they aren't decorative) and that
// the config-driven roster loads / overrides as documented.

const NOW = new Date("2026-01-15T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400000);

describe("shapeOpts — shape → foldDim options", () => {
  const cases: Array<[DriveShape, Record<string, unknown>]> = [
    ["symmetric", {}],
    ["refractory", { refractoryMode: true }],
    ["bonding", { bondSatMode: true }],
    ["owed", { wantOnly: true }],
  ];
  for (const [shape, expected] of cases) {
    it(`${shape} → ${JSON.stringify(expected)}`, () => {
      expect(shapeOpts(shape)).toEqual(expected);
    });
  }
  it("threads wantScale through", () => {
    expect(shapeOpts("symmetric", 21)).toEqual({ wantScale: 21 });
    expect(shapeOpts("owed", 21)).toEqual({ wantOnly: true, wantScale: 21 });
  });
});

describe("foldDim — the four shapes diverge on the same backing", () => {
  // One positive event a day ago: high recency, low want.
  const backing = [{ valence: 0.8, createdAt: daysAgo(1), validFrom: null, bondClosure: false }];

  it("symmetric stays high right after an event (recency leg)", () => {
    const sym = foldDim(backing, NOW, shapeOpts("symmetric"));
    const refr = foldDim(backing, NOW, shapeOpts("refractory"));
    // refractory SUPPRESSES right after satisfaction; symmetric does not.
    expect(sym.confidence).toBeGreaterThan(refr.confidence);
  });

  it("refractory never falls below the tonic floor × grounding", () => {
    const refr = foldDim(backing, NOW, shapeOpts("refractory"));
    // floor 0.07 × grounding 0.8 = 0.056; suppressed branch can't go under it.
    expect(refr.confidence).toBeGreaterThanOrEqual(0.8 * 0.07 - 1e-9);
  });

  it("owed is want-only: low right after, no recency boost", () => {
    const owed = foldDim(backing, NOW, shapeOpts("owed"));
    const sym = foldDim(backing, NOW, shapeOpts("symmetric"));
    expect(owed.confidence).toBeLessThan(sym.confidence);
  });

  it("bonding satiety presses the recency leg after a CLOSED positive bond", () => {
    const recent = (bondClosure: boolean) => [{ valence: 0.9, createdAt: daysAgo(0), validFrom: null, bondClosure }];
    const closed = foldDim(recent(true), NOW, shapeOpts("bonding"));
    const open = foldDim(recent(false), NOW, shapeOpts("bonding"));
    // A just-closed bond is less urgent to reopen → lower drive than an unclosed one.
    expect(closed.confidence).toBeLessThan(open.confidence);
  });

  it("no grounding (no positive backing) → dim does not stand up", () => {
    const empty = foldDim([], NOW, shapeOpts("symmetric"));
    expect(empty.grounding).toBe(0);
    expect(empty.confidence).toBe(0);
  });
});

describe("loadDriveDefs — config-driven roster", () => {
  afterEach(() => {
    delete process.env.DRIVE_DIMS;
  });

  it("ships a 4-dim example roster, one per shape", () => {
    const defs = loadDriveDefs();
    expect(defs.map((d) => d.key)).toEqual(["companionship", "desire", "deep_talk", "owed"]);
    expect(new Set(defs.map((d) => d.shape))).toEqual(new Set(["symmetric", "refractory", "bonding", "owed"]));
  });

  it("DRIVE_DIMS env overrides the example roster", () => {
    process.env.DRIVE_DIMS = JSON.stringify([{ key: "longing", label: "思念", shape: "symmetric", backing: { memoryTypes: ["EPISODE"] } }]);
    const defs = loadDriveDefs();
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ key: "longing", label: "思念", shape: "symmetric" });
  });

  it("malformed DRIVE_DIMS falls back to the example roster", () => {
    process.env.DRIVE_DIMS = "{not json";
    expect(loadDriveDefs().map((d) => d.key)).toContain("companionship");
  });
});
