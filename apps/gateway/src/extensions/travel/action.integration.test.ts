import { describe, it, expect, afterAll } from "vitest";
import prisma from "../../db.js";
import { travelAction } from "./action.js";

// DB integration — exercises the opt-in TRAVEL action handler across the three
// outcomes: skipped (empty content), staged (propose mode → no write), committed
// (auto mode → writes a SELF EPISODE memory). mode is stashed on ctx the way
// dispatchAction does it. Local DB only; skipped in CI.
const local = process.env.DATABASE_URL?.includes("localhost") ? describe : describe.skip;

local("travel action (opt-in generative daemon action)", () => {
  const createdIds: string[] = [];
  const now = new Date("2026-01-02T10:00:00Z");

  afterAll(async () => {
    if (createdIds.length) await prisma.memory.deleteMany({ where: { id: { in: createdIds } } });
    await prisma.$disconnect();
  });

  it("empty content → skipped (no memory)", async () => {
    const r = await travelAction.run({ parsed: { action_content: "" }, now } as any);
    expect(r.outcome).toBe("skipped");
    expect(r.artifactId).toBeUndefined();
  });

  it("propose mode → staged, withholds the write", async () => {
    const r = await travelAction.run({ parsed: { action_content: "a slow walk along a cold river at dawn" }, now, mode: "propose" } as any);
    expect(r.outcome).toBe("staged");
    expect(r.performed).toBe(false);
    expect(r.artifactId).toBeUndefined();
  });

  it("auto mode → committed, writes a SELF EPISODE memory", async () => {
    const r = await travelAction.run({ parsed: { action_content: "a slow walk along a cold river at dawn", valence: 0.4, arousal: 0.3 }, now, mode: "auto" } as any);
    expect(r.outcome).toBe("committed");
    expect(r.performed).toBe(true);
    expect(r.artifactId).toBeTruthy();
    createdIds.push(r.artifactId!);
    const m = await prisma.memory.findUnique({ where: { id: r.artifactId! } });
    expect(m?.memoryType).toBe("EPISODE");
    expect(m?.experiencer).toBe("SELF");
    expect(m?.resolution).toBe("RESOLVED");
    expect(m?.content).toContain("cold river");
  });
});
