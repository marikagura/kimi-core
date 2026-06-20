import { describe, it, expect, afterAll } from "vitest";
import prisma from "../db.js";
import { writeSessionScore } from "./session-score.js";

// DB integration (I2) — the extracted writeSessionScore. Asserts the SELF_SCORE
// row it writes (v/a, RESOLVED, experiencer SELF) and the title-based dedup that
// keeps a re-run from double-writing. Local DB only; skipped in CI.
const local = process.env.DATABASE_URL?.includes("localhost") ? describe : describe.skip;

local("I2 — writeSessionScore writes a deduped SELF_SCORE memory", () => {
  const dateStr = `i2-${Date.now()}`;
  const startHHMM = "23:59";
  const title = `chat-score ${dateStr} ${startHHMM}`;
  const firstAt = new Date("2026-01-01T20:00:00Z");
  const lastAt = new Date("2026-01-01T23:00:00Z");

  afterAll(async () => {
    await prisma.memory.deleteMany({ where: { memoryType: "SELF_SCORE", title } });
    await prisma.$disconnect();
  });

  it("writes the score row, then dedups on a second call with the same title", async () => {
    const r1 = await writeSessionScore({ dateStr, startHHMM, valence: -0.4, arousal: 0.6, note: "tough session", firstAt, lastAt });
    expect(r1.written).toBe(true);

    const row = await prisma.memory.findFirst({ where: { memoryType: "SELF_SCORE", title } });
    expect(row).toBeTruthy();
    expect(row!.valence).toBeCloseTo(-0.4);
    expect(row!.arousal).toBeCloseTo(0.6);
    expect(row!.resolution).toBe("RESOLVED");
    expect(row!.experiencer).toBe("SELF");
    expect(row!.summary).toBe("tough session");
    expect(row!.validFrom?.getTime()).toBe(lastAt.getTime());

    // dedup: a second call (even with different v/a) must not write a 2nd row.
    const r2 = await writeSessionScore({ dateStr, startHHMM, valence: 0.9, arousal: 0.1, note: "different", firstAt, lastAt });
    expect(r2.written).toBe(false);
    const count = await prisma.memory.count({ where: { memoryType: "SELF_SCORE", title } });
    expect(count).toBe(1);
  });

  it("falls back to a default note when none is given", async () => {
    const r = await writeSessionScore({ dateStr: `${dateStr}-b`, startHHMM, valence: 0.2, arousal: 0.3, note: "", firstAt, lastAt });
    expect(r.written).toBe(true);
    const row = await prisma.memory.findFirst({ where: { memoryType: "SELF_SCORE", title: `chat-score ${dateStr}-b ${startHHMM}` } });
    expect(row!.summary).toBe(`${dateStr}-b session`);
    await prisma.memory.deleteMany({ where: { memoryType: "SELF_SCORE", title: `chat-score ${dateStr}-b ${startHHMM}` } });
  });
});
