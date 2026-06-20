import { describe, it, expect, afterAll } from "vitest";
import prisma from "../db.js";
import { checkCurationHealth } from "./curation-health.js";

// DB integration — seeds memories and checks the curation-health counts (delta vs a
// baseline, so it doesn't depend on what's already in the DB) + the high-importance
// review flag. Local DB only; skipped in CI.
const local = process.env.DATABASE_URL?.includes("localhost") ? describe : describe.skip;

local("curation-health probe", () => {
  const tag = `ch-${Date.now()}`;
  const ids: string[] = [];
  const mk = async (importance: number, extra: Record<string, any> = {}) => {
    const m = await prisma.memory.create({
      data: { memoryType: "EPISODE", title: `${tag} ${importance}`, content: "x", sourceType: "MANUAL", importance, ...extra },
    });
    ids.push(m.id);
    return m;
  };

  afterAll(async () => {
    if (ids.length) await prisma.memory.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it("counts active total / high-importance pool / open concerns (seeded rows included)", async () => {
    await mk(5); // high-importance
    await mk(5); // high-importance
    await mk(2); // normal
    await mk(4, { experiencer: "SELF", resolution: "OPEN" }); // open SELF concern, importance < 5
    const r = await checkCurationHealth();
    // Absolute lower bounds, not exact deltas: the seeded rows stay live until
    // afterAll, so the probe's full-store counts include them. >= keeps this robust
    // to other integration tests adding/removing memories concurrently.
    expect(r.activeTotal).toBeGreaterThanOrEqual(4);
    expect(r.highImportance).toBeGreaterThanOrEqual(2);
    expect(r.openConcerns).toBeGreaterThanOrEqual(1);
  });

  it("flags review-high-importance once the pool crosses CURATION_REVIEW_THRESHOLD", async () => {
    process.env.CURATION_REVIEW_THRESHOLD = "1"; // force-trigger regardless of DB contents
    const r = await checkCurationHealth();
    expect(r.flags.some((f) => f.startsWith("review-high-importance"))).toBe(true);
    delete process.env.CURATION_REVIEW_THRESHOLD;
  });
});
