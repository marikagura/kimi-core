import { describe, it, expect, afterAll } from "vitest";
import prisma from "./db.js";
import { SELF_CONCERN_DEFAULTS, upsertActiveState } from "./tools.js";

// The ORIGINAL inline upsert logic, copied verbatim, so T2 can differential-compare
// the helper against it (same input → same DB outcome) rather than trust reasoning.
async function oldUpsert(stateType: any, title: string, summary: string, content: string, source?: string) {
  const existing = await prisma.activeState.findFirst({ where: { stateType, title, isActive: true }, select: { id: true } });
  if (existing) {
    await prisma.activeState.update({ where: { id: existing.id }, data: { summary, content, source } });
    return { created: false };
  }
  await prisma.activeState.create({ data: { stateType, title, summary, content, source } });
  return { created: true };
}

// DB integration — runs only against a local throwaway DB (DATABASE_URL=localhost);
// skipped in CI, which has no database. Source .env before `vitest run`.
const local = process.env.DATABASE_URL?.includes("localhost") ? describe : describe.skip;

local("T1 — SELF_CONCERN_DEFAULTS spread writes the same row as the old literal", () => {
  const ids: string[] = [];
  afterAll(async () => {
    if (ids.length) await prisma.memory.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it("state_set variant: MANUAL provenance + the shared SELF/SUBJECTIVE/OPEN defaults", async () => {
    const m = await prisma.memory.create({
      data: { ...SELF_CONCERN_DEFAULTS, title: "t1-state", summary: "s", content: "c", sourceType: "MANUAL", concernKey: "cc_t1state" },
    });
    ids.push(m.id);
    expect(m.memoryType).toBe("STATE");
    expect(m.experiencer).toBe("SELF");
    expect(m.grounding).toBe("SUBJECTIVE");
    expect(m.resolution).toBe("OPEN");
    expect(m.importance).toBe(4);
    expect(m.valence).toBe(-0.3);
    expect(m.arousal).toBe(0.4);
    expect(m.sourceType).toBe("MANUAL");
    expect(m.concernKey).toBe("cc_t1state");
    expect(m.authorModel).toBeNull();
  });

  it("closeout variant: CHAT provenance + authorModel, identical defaults", async () => {
    const m = await prisma.memory.create({
      data: { ...SELF_CONCERN_DEFAULTS, title: "t1-closeout", summary: "s", content: "c", sourceType: "CHAT", concernKey: "cc_t1close", authorModel: "test/model" },
    });
    ids.push(m.id);
    expect(m.sourceType).toBe("CHAT");
    expect(m.authorModel).toBe("test/model");
    expect(m.grounding).toBe("SUBJECTIVE");
    expect(m.experiencer).toBe("SELF");
    expect(m.valence).toBe(-0.3);
  });
});

local("T2 — upsertActiveState is behavior-identical to the original inline logic", () => {
  const titles = ["t2-old-create", "t2-new-create", "t2-old-upd", "t2-new-upd", "t2-scope"];
  afterAll(async () => {
    await prisma.activeState.deleteMany({ where: { title: { in: titles } } });
    await prisma.$disconnect();
  });
  const shape = (r: any) => ({ stateType: r.stateType, summary: r.summary, content: r.content, source: r.source, isActive: r.isActive });

  it("create path: old vs new → same {created:true} and an identical row", async () => {
    const oldR = await oldUpsert("MOOD", "t2-old-create", "s", "c", "src");
    const newR = await upsertActiveState({ stateType: "MOOD", title: "t2-new-create", summary: "s", content: "c", source: "src" });
    expect(newR).toEqual(oldR);
    expect(newR.created).toBe(true);
    const [a, b] = await Promise.all([
      prisma.activeState.findFirst({ where: { title: "t2-old-create" } }),
      prisma.activeState.findFirst({ where: { title: "t2-new-create" } }),
    ]);
    expect(shape(b)).toEqual(shape(a));
  });

  it("update path: old vs new → same {created:false} and identical fields written", async () => {
    await prisma.activeState.create({ data: { stateType: "STRESS", title: "t2-old-upd", summary: "old", content: "old", source: "x", isActive: true } });
    await prisma.activeState.create({ data: { stateType: "STRESS", title: "t2-new-upd", summary: "old", content: "old", source: "x", isActive: true } });
    const oldR = await oldUpsert("STRESS", "t2-old-upd", "new", "new", "closeout");
    const newR = await upsertActiveState({ stateType: "STRESS", title: "t2-new-upd", summary: "new", content: "new", source: "closeout" });
    expect(newR).toEqual(oldR);
    expect(newR.created).toBe(false);
    const [a, b] = await Promise.all([
      prisma.activeState.findFirst({ where: { title: "t2-old-upd" } }),
      prisma.activeState.findFirst({ where: { title: "t2-new-upd" } }),
    ]);
    expect({ summary: b!.summary, content: b!.content, source: b!.source }).toEqual({ summary: a!.summary, content: a!.content, source: a!.source });
    expect(b!.summary).toBe("new");
  });

  it("isActive scope (load-bearing): a CLOSED same-title state is NOT revived — a new active row is created", async () => {
    await prisma.activeState.create({ data: { stateType: "HEALTH", title: "t2-scope", summary: "closed", content: "closed", source: "x", isActive: false } });
    const r = await upsertActiveState({ stateType: "HEALTH", title: "t2-scope", summary: "fresh", content: "fresh", source: "y" });
    expect(r.created).toBe(true);
    const rows = await prisma.activeState.findMany({ where: { title: "t2-scope" } });
    expect(rows.length).toBe(2);
    expect(rows.filter((x) => x.isActive).length).toBe(1);
    expect(rows.find((x) => !x.isActive)!.summary).toBe("closed");
  });
});
