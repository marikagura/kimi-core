// Memory <-> memory `similar` edges. Stored in the generic `links` table as
// (fromType=memory, toType=memory, relationType=similar) with cosine sim
// dropped into `confidence`.
//
// Background — why this exists as a sweep:
//   The closeout path used to be the only place that built these edges, and it
//   only fired when a closeout was called with new keyMemories. In practice
//   most memories arrive through memory_write / auto-digest and bypass closeout
//   entirely — leaving 0 effective edges in DB. This sweep is the catch-up path
//   that builds edges regardless of how a memory was created.
//
// Triggered nightly from the scheduler on memories without any outgoing
// similar-edge. Idempotent — a memory that already has edges is skipped (we
// check existence before doing the cosine query).

import prisma from "../db.js";
import { embedText, toVectorLiteral } from "./embed.js";

// Min cosine similarity to record an edge. 0.3 trades off a bit of noise for
// keeping near-but-not-tight relations. Top-K is capped at 3 — more is rarely
// useful and floods links. Both can be overridden via config.
const MIN_CONFIDENCE = 0.3;
const TOP_K = 3;

export async function sweepMemorySimilarity(memoryId: string): Promise<number> {
  // Skip if this memory already has outgoing similar-edges. The sweep is
  // append-only, so doing nothing here keeps it idempotent.
  const existing = await prisma.link.count({
    where: {
      fromType: "memory",
      fromId: memoryId,
      toType: "memory",
      relationType: "similar",
    },
  });
  if (existing > 0) return 0;

  const m = await prisma.memory.findUnique({
    where: { id: memoryId },
    select: { title: true, summary: true, content: true, isActive: true },
  });
  if (!m || !m.isActive) return 0;

  const text = `${m.title} ${m.summary ?? m.content ?? ""}`.trim();
  if (!text) return 0;

  const emb = await embedText(text);
  if (!emb) return 0;

  const sims = await findSimilarMemories(emb, memoryId);
  let created = 0;
  for (const s of sims) {
    // Upsert on the Link natural-key unique so a concurrent indexer racing past the
    // count() short-circuit above can't double-write the same similar edge.
    await prisma.link.upsert({
      where: {
        fromType_fromId_toType_toId_relationType: {
          fromType: "memory",
          fromId: memoryId,
          toType: "memory",
          toId: s.id,
          relationType: "similar",
        },
      },
      create: {
        fromType: "memory",
        fromId: memoryId,
        toType: "memory",
        toId: s.id,
        relationType: "similar",
        confidence: s.confidence,
        note: `auto-sweep cosine ${s.confidence.toFixed(2)}`,
      },
      update: {},
    });
    created++;
  }
  return created;
}

// Top-K nearest active memories by cosine distance, thresholded — the ONE cosine
// query both edge-builders (this sweep + closeout) share, so K / the threshold
// can't drift between the two creation paths. confidence = 1 - distance, rounded.
export async function findSimilarMemories(emb: number[], excludeId: string): Promise<{ id: string; confidence: number }[]> {
  const vec = toVectorLiteral(emb);
  const related: { id: string; distance: number }[] = await prisma.$queryRaw`
    SELECT id, (embedding <=> ${vec}::vector) AS distance
    FROM memories
    WHERE "isActive" = true
      AND embedding IS NOT NULL
      AND id::text != ${excludeId}
    ORDER BY embedding <=> ${vec}::vector
    LIMIT ${TOP_K}
  `;
  return related
    .map((r) => ({ id: r.id, raw: 1.0 - Number(r.distance) }))
    .filter((r) => r.raw >= MIN_CONFIDENCE)
    .map((r) => ({ id: r.id, confidence: Math.round(r.raw * 100) / 100 }));
}

// Cron entry point: find every active memory missing similar edges and run
// the sweep. Returns { scanned, edgesCreated } for logging.
export async function sweepAllMissingSimilarity(opts: { limit?: number } = {}): Promise<{
  scanned: number;
  memoriesPatched: number;
  edgesCreated: number;
}> {
  const { limit = 200 } = opts;
  // Memories with no outgoing similar-edge — built from a LEFT JOIN against
  // a subquery so a single query gives us exactly the missing set.
  const rows: { id: string }[] = await prisma.$queryRaw`
    SELECT m.id
    FROM memories m
    LEFT JOIN (
      SELECT DISTINCT "fromId" FROM links
      WHERE "fromType" = 'memory' AND "toType" = 'memory' AND "relationType" = 'similar'
    ) l ON l."fromId" = m.id
    WHERE m."isActive" = true AND l."fromId" IS NULL
    ORDER BY m."createdAt" DESC
    LIMIT ${limit}
  `;
  let total = 0;
  let touched = 0;
  for (const r of rows) {
    const n = await sweepMemorySimilarity(r.id);
    total += n;
    if (n > 0) touched++;
  }
  return { scanned: rows.length, memoriesPatched: touched, edgesCreated: total };
}
