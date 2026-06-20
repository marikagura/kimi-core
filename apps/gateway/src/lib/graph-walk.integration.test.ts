import { describe, it, expect, beforeAll, afterAll } from "vitest";
import prisma from "../db.js";
import { walkGraph } from "./graph-walk.js";

// DB integration (R4) — seeds a tiny KG and walks it, exercising BOTH relFilter
// branches (relationType present → Prisma.sql fragment; absent → Prisma.empty)
// across forward and reverse edges. Runs only against a local DB; skipped in CI.
const local = process.env.DATABASE_URL?.includes("localhost") ? describe : describe.skip;

local("R4 — graph-walk relationType fold (forward + reverse, filter on/off)", () => {
  const A = { id: "" }, B = { id: "" }, C = { id: "" }, D = { id: "" };

  beforeAll(async () => {
    const mk = async (title: string) =>
      (await prisma.memory.create({ data: { memoryType: "EPISODE", title, content: "x", sourceType: "MANUAL" } })).id;
    A.id = await mk("r4-A"); B.id = await mk("r4-B"); C.id = await mk("r4-C"); D.id = await mk("r4-D");
    const link = (fromId: string, toId: string, rel: string) =>
      prisma.link.create({ data: { fromType: "memory", fromId, toType: "memory", toId, relationType: rel, confidence: 0.9 } });
    await link(A.id, B.id, "similar");   // forward, similar
    await link(A.id, C.id, "mentions");  // forward, different rel
    await link(D.id, A.id, "similar");   // reverse (D→A), similar
  });
  afterAll(async () => {
    const ids = [A.id, B.id, C.id, D.id];
    await prisma.link.deleteMany({ where: { OR: [{ fromId: { in: ids } }, { toId: { in: ids } }] } });
    await prisma.memory.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  const walk = (opts: any) => walkGraph({ startIds: [A.id], startType: "memory", hops: 1, ...opts });
  const ids = (ns: any[]) => new Set(ns.map((n) => n.id));

  it("no relationType, forward only → reaches both forward neighbours (relFilter=empty)", async () => {
    const s = ids(await walk({ undirected: false }));
    expect(s).toEqual(new Set([B.id, C.id]));
  });

  it("relationType=similar, forward only → only the 'similar' edge (relFilter=Prisma.sql)", async () => {
    const s = ids(await walk({ undirected: false, relationType: "similar" }));
    expect(s).toEqual(new Set([B.id])); // C is via 'mentions', filtered out
  });

  it("undirected → also follows the reverse 'similar' edge from D", async () => {
    const s = ids(await walk({ undirected: true }));
    expect(s).toEqual(new Set([B.id, C.id, D.id]));
  });

  it("relationType=similar + undirected → similar forward (B) AND reverse (D), not mentions (C)", async () => {
    const s = ids(await walk({ undirected: true, relationType: "similar" }));
    expect(s).toEqual(new Set([B.id, D.id]));
  });
});
