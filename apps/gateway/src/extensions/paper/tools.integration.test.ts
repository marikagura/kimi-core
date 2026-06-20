import { describe, it, expect, afterAll } from "vitest";
import prisma from "../../db.js";
import { registerPaperTools } from "./tools.js";

// DB integration — captures the paper tools' handlers via a mock MCP server and
// exercises paper_write (externalId dedup → update, not duplicate) + paper_search
// (keyword over knowledge + axis filter). Local DB only; skipped in CI.
const local = process.env.DATABASE_URL?.includes("localhost") ? describe : describe.skip;

function captureHandlers(): Record<string, (args: any) => Promise<any>> {
  const handlers: Record<string, (args: any) => Promise<any>> = {};
  const server: any = {
    tool: (name: string, _desc: string, _schema: any, handler: (args: any) => Promise<any>) => {
      handlers[name] = handler;
    },
  };
  registerPaperTools(server);
  return handlers;
}

local("paper extension tools", () => {
  const h = captureHandlers();
  const ext = `t-${Date.now()}`;

  afterAll(async () => {
    await prisma.paperNote.deleteMany({ where: { externalId: { startsWith: ext } } });
    await prisma.$disconnect();
  });

  it("paper_write: creates, then dedups on externalId (updates, no duplicate)", async () => {
    await h.paper_write({ title: "First", knowledge: "k1", externalId: `${ext}-1`, axis: "ml" });
    await h.paper_write({ title: "First v2", knowledge: "k1 updated", externalId: `${ext}-1`, axis: "ml" });
    const rows = await prisma.paperNote.findMany({ where: { externalId: `${ext}-1` } });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("First v2");
    expect(rows[0].knowledge).toBe("k1 updated");
  });

  it("paper_search: keyword over knowledge, and axis filter narrows", async () => {
    await h.paper_write({ title: "Zenith folding", knowledge: "distinct-token-xyz finding", externalId: `${ext}-2`, axis: "bio" });
    const hit = await h.paper_search({ query: "distinct-token-xyz" });
    expect(hit.content[0].text).toContain("Zenith folding");
    const missAxis = await h.paper_search({ query: "distinct-token-xyz", axis: "no-such-axis" });
    expect(missAxis.content[0].text).toContain("No paper_notes matched");
  });
});
