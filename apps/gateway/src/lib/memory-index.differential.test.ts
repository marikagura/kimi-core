import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// DB DIFFERENTIAL (T4) — the rigorous old-vs-new proof, made deterministic.
//
// indexNewMemory replaced three near-copies of the embed + mention (+ similar)
// post-create logic. To prove the new path builds byte-identical DB state to the
// old inline code, the variable under test must be the INDEXING LOGIC, not the
// embed API — so embText is stubbed to a fixed vector. The neighbour is seeded
// with that same vector → cosine distance 0 → confidence 1.0, every run, with no
// network and no cross-test embed contention. (Real embeddings are exercised by
// the I3 sweep test and the real-embed smoke in memory-index.integration.test.ts.)
//
// Needs a local DB; no keys. Skipped in CI (no DB).
const { FIXED_VEC } = vi.hoisted(() => ({
  FIXED_VEC: Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)), // unit vector e0
}));
vi.mock("./embed.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, embedText: vi.fn(async () => FIXED_VEC) }; // writeEmbedding stays real
});

import prisma from "../db.js";
import { embedText, writeEmbedding } from "./embed.js";
import { findSimilarMemories } from "./memory-similarity.js";
import { sweepMemoryMentions, clearEntityCache } from "./entity-mentions.js";
import { indexNewMemory } from "./memory-index.js";

const local = process.env.DATABASE_URL?.includes("localhost") ? describe : describe.skip;

// A faithful copy of the ORIGINAL closeout keyMemories indexing (pre-T4): mention
// sweep wrapped, then embed → writeEmbedding → findSimilarMemories → link.create.
async function oldIndexInline(memoryId: string, text: string): Promise<void> {
  try {
    await sweepMemoryMentions(memoryId);
  } catch {
    /* original swallowed mention-sweep failures */
  }
  const emb = await embedText(text);
  if (!emb) return;
  await writeEmbedding("memories", memoryId, emb);
  const sims = await findSimilarMemories(emb, memoryId);
  for (const s of sims) {
    await prisma.link.create({
      data: {
        fromType: "memory",
        fromId: memoryId,
        toType: "memory",
        toId: s.id,
        relationType: "similar",
        confidence: s.confidence,
        note: `auto-linked at closeout (cosine sim ${s.confidence.toFixed(2)})`,
      },
    });
  }
}

async function hasEmbedding(id: string): Promise<boolean> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT (embedding IS NOT NULL) AS has FROM memories WHERE id = $1`,
    id,
  );
  return rows[0]?.has === true;
}
async function mentionFromIds(memId: string): Promise<Set<string>> {
  const links = await prisma.link.findMany({
    where: { toType: "memory", toId: memId, relationType: "mentions" },
    select: { fromId: true },
  });
  return new Set(links.map((l) => l.fromId));
}
async function similarEdges(memId: string): Promise<{ toId: string; confidence: number }[]> {
  const links = await prisma.link.findMany({
    where: { fromType: "memory", fromId: memId, relationType: "similar" },
    select: { toId: true, confidence: true },
  });
  return links
    .map((l) => ({ toId: l.toId, confidence: l.confidence }))
    .sort((a, b) => a.toId.localeCompare(b.toId));
}

local("T4 differential — indexNewMemory builds the same edges as the original inline code", () => {
  const token = `Zephyrine${Date.now()}`; // single alnum word → mention matcher \bToken\b fires
  const titlePart = `${token} harbor`;
  const summaryPart = "lanterns at dusk";
  const S = `${titlePart} ${summaryPart}`;
  let entityId = "";
  let neighbourId = "";
  const mk = (extra: Record<string, any> = {}) =>
    prisma.memory.create({
      data: { memoryType: "EPISODE", title: titlePart, summary: summaryPart, content: "body text", sourceType: "MANUAL", ...extra },
    });

  beforeAll(async () => {
    const e = await prisma.entity.create({ data: { entityType: "CONCEPT", name: token } });
    entityId = e.id;
    clearEntityCache();
    const n = await mk({ title: `N ${titlePart}` });
    neighbourId = n.id;
    await writeEmbedding("memories", n.id, FIXED_VEC); // seed neighbour with the fixed vector
  });

  afterAll(async () => {
    const ids = [neighbourId].filter(Boolean);
    await prisma.link.deleteMany({ where: { OR: [{ fromId: { in: ids } }, { toId: { in: ids } }] } });
    await prisma.memory.deleteMany({ where: { id: { in: ids } } });
    if (entityId) {
      await prisma.link.deleteMany({ where: { fromId: entityId } });
      await prisma.entity.delete({ where: { id: entityId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it("old inline vs new indexNewMemory → identical embedding, mention edges, similar edges", async () => {
    // PASS 1 — ORIGINAL inline logic on X.
    const X = await mk();
    await oldIndexInline(X.id, S);
    const xEmbedded = await hasEmbedding(X.id);
    const xMentions = await mentionFromIds(X.id);
    const xSimilar = await similarEdges(X.id);
    // Remove X so it can't become a candidate for Y (identical vector → distance 0).
    await prisma.link.deleteMany({ where: { OR: [{ fromId: X.id }, { toId: X.id }] } });
    await prisma.memory.delete({ where: { id: X.id } });

    // PASS 2 — NEW indexNewMemory on Y (same input, same fixed vector).
    const Y = await mk();
    const res = await indexNewMemory(Y.id, S, { withSimilarEdges: true, logTag: "test" });
    const yEmbedded = await hasEmbedding(Y.id);
    const yMentions = await mentionFromIds(Y.id);
    const ySimilar = await similarEdges(Y.id);
    await prisma.link.deleteMany({ where: { OR: [{ fromId: Y.id }, { toId: Y.id }] } });
    await prisma.memory.delete({ where: { id: Y.id } });

    // embedding written by both
    expect(xEmbedded).toBe(true);
    expect(yEmbedded).toBe(true);
    expect(res.embedded).toBe(true);

    // the arms actually fired: mention edge to the seeded entity, similar edge to
    // the seeded neighbour at confidence 1.0 (distance 0).
    expect(xMentions.has(entityId)).toBe(true);
    expect(xSimilar.some((e) => e.toId === neighbourId && e.confidence === 1)).toBe(true);

    // old == new: identical mention set and identical similar set (toId + confidence)
    expect([...yMentions].sort()).toEqual([...xMentions].sort());
    expect(ySimilar).toEqual(xSimilar);
    expect(res.edgesCreated).toBe(ySimilar.length);
  });
});
