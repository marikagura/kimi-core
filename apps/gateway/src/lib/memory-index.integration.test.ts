import { describe, it, expect, beforeAll, afterAll } from "vitest";
import prisma from "../db.js";
import { embedText, writeEmbedding } from "./embed.js";
import { clearEntityCache } from "./entity-mentions.js";
import { indexNewMemory } from "./memory-index.js";

// DB real-embed smoke (T4) — drives indexNewMemory through its full REAL path
// (real embText → writeEmbedding → mention sweep → findSimilarMemories → links)
// and asserts all three arms fire: embedding written, an entity→memory mention
// edge to a seeded entity, and a memory→memory similar edge to a seeded neighbour.
// Tolerant by design (presence, not exact confidence) — the byte-exact old-vs-new
// comparison lives in memory-index.differential.test.ts (deterministic). Needs a
// real embed endpoint (EMBED_* in .env) + a local DB; skipped in CI.
const local = process.env.DATABASE_URL?.includes("localhost") ? describe : describe.skip;

// embText already retries 429s internally; this guards the rarer null (transient
// outage / saturation under the parallel test run) so the seeded neighbour is
// reliably embedded and thus a real similar-edge candidate.
async function embedWithRetry(text: string, tries = 4): Promise<number[]> {
  for (let i = 0; i < tries; i++) {
    const emb = await embedText(text);
    if (emb) return emb;
  }
  throw new Error("embedText returned null after retries — embed endpoint unavailable");
}

local("T4 real-embed smoke — indexNewMemory builds embedding + mention + similar edges", () => {
  const token = `Mistralia${Date.now()}`; // single alnum word → mention matcher \bToken\b fires
  const titlePart = `${token} harbor`;
  const summaryPart = "lanterns at dusk";
  const S = `${titlePart} ${summaryPart}`;
  let entityId = "";
  let neighbourId = "";
  let targetId = "";
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
    await writeEmbedding("memories", n.id, await embedWithRetry(S)); // real embedding, same text
  });

  afterAll(async () => {
    const ids = [neighbourId, targetId].filter(Boolean);
    await prisma.link.deleteMany({ where: { OR: [{ fromId: { in: ids } }, { toId: { in: ids } }] } });
    await prisma.memory.deleteMany({ where: { id: { in: ids } } });
    if (entityId) {
      await prisma.link.deleteMany({ where: { fromId: entityId } });
      await prisma.entity.delete({ where: { id: entityId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it("all three arms fire on the real path", async () => {
    const m = await mk();
    targetId = m.id;
    const res = await indexNewMemory(m.id, S, { withSimilarEdges: true, logTag: "test" });

    // embedding arm
    expect(res.embedded).toBe(true);
    const embRows: any[] = await prisma.$queryRawUnsafe(
      `SELECT (embedding IS NOT NULL) AS has FROM memories WHERE id = $1`,
      m.id,
    );
    expect(embRows[0]?.has).toBe(true);

    // mention arm — entity→memory edge to the seeded entity
    const mention = await prisma.link.findFirst({
      where: { fromType: "entity", fromId: entityId, toType: "memory", toId: m.id, relationType: "mentions" },
    });
    expect(mention).toBeTruthy();

    // similar arm — memory→memory edge to the seeded neighbour (identical text →
    // high cosine ≥ the 0.3 threshold), and the returned count matches the edges.
    expect(res.edgesCreated).toBeGreaterThanOrEqual(1);
    const similar = await prisma.link.findFirst({
      where: { fromType: "memory", fromId: m.id, toType: "memory", toId: neighbourId, relationType: "similar" },
    });
    expect(similar).toBeTruthy();
    expect(similar!.confidence).toBeGreaterThanOrEqual(0.3);
    const similarCount = await prisma.link.count({
      where: { fromType: "memory", fromId: m.id, relationType: "similar" },
    });
    expect(res.edgesCreated).toBe(similarCount);
  });
});
