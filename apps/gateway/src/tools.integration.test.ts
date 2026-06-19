import { describe, it, expect, afterAll } from "vitest";
import prisma from "./db.js";
import { SELF_CONCERN_DEFAULTS } from "./tools.js";

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
