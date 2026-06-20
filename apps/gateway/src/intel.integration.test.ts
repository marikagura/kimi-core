import { describe, it, expect, afterAll } from "vitest";
import prisma from "./db.js";
import { sweepTable, SWEEP_TABLES } from "./intel.js";

// DB integration (I3) — seeds one stale (null-embedding) row per embeddable table
// and runs the REAL production config through the extracted sweepTable, asserting
// the embedding gets written. Exercises the needsSummary branch (memories selects
// + embeds `summary`; observations / core_profile have no summary column). Needs a
// real embed endpoint (EMBED_* in .env) + a local DB; skipped in CI (no DB/keys).
const local = process.env.DATABASE_URL?.includes("localhost") ? describe : describe.skip;

async function hasEmbedding(table: string, id: string): Promise<boolean> {
  // table is a fixed config key, never user text — no injection surface. embedding
  // is Unsupported("vector(1536)") and can't be selected via Prisma, so probe IS NOT NULL.
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT (embedding IS NOT NULL) AS has FROM ${table} WHERE id = $1`,
    id,
  );
  return rows[0]?.has === true;
}

local("I3 — sweepTable re-embeds stale rows across all three tables", () => {
  const uniq = `i3-${Date.now()}`;
  const seeded: { table: string; id: string }[] = [];
  const cfg = (t: string) => SWEEP_TABLES.find((c) => c.table === t)!;

  afterAll(async () => {
    for (const s of seeded) {
      await prisma.$executeRawUnsafe(`DELETE FROM ${s.table} WHERE id = $1`, s.id);
    }
    await prisma.$disconnect();
  });

  it("memories: null embedding → embedded (title + summary)", async () => {
    const m = await prisma.memory.create({
      data: { memoryType: "STATE", title: `${uniq} mem`, content: "body", summary: "summary line", sourceType: "MANUAL" },
    });
    seeded.push({ table: "memories", id: m.id });
    expect(await hasEmbedding("memories", m.id)).toBe(false); // sanity: starts null
    await sweepTable(cfg("memories"));
    expect(await hasEmbedding("memories", m.id)).toBe(true);
  });

  it("observations: null embedding → embedded (title + content, no summary col)", async () => {
    const o = await prisma.observation.create({
      data: { subject: "test", key: `${uniq}-obs`, title: `${uniq} obs`, content: "obs body" },
    });
    seeded.push({ table: "observations", id: o.id });
    expect(await hasEmbedding("observations", o.id)).toBe(false);
    await sweepTable(cfg("observations"));
    expect(await hasEmbedding("observations", o.id)).toBe(true);
  });

  it("core_profile: null embedding → embedded (title + content)", async () => {
    const c = await prisma.coreProfile.create({
      data: { key: `${uniq}-cp`, title: `${uniq} cp`, content: "profile body" },
    });
    seeded.push({ table: "core_profile", id: c.id });
    expect(await hasEmbedding("core_profile", c.id)).toBe(false);
    await sweepTable(cfg("core_profile"));
    expect(await hasEmbedding("core_profile", c.id)).toBe(true);
  });
});
