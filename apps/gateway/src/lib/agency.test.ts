import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Prisma client so action handlers run without a database. We assert
// BEHAVIOR (outcome / performed / which writes fire), not persistence — the point
// is that the dispatcher does the right thing, verified by running it, not by
// reading the code.
vi.mock("../db.js", () => ({
  default: {
    event: { create: vi.fn(async () => ({ id: "ev_test" })) },
    memory: { create: vi.fn(async () => ({ id: "mem_test" })) },
    pendingItem: { create: vi.fn(async () => ({ id: "pi_test" })) },
  },
}));

import prisma from "../db.js";
import {
  dispatchAction,
  listActions,
  registerAction,
  recordScoreFeedback,
  type SearchProvider,
} from "./agency.js";

const db = prisma as unknown as {
  event: { create: ReturnType<typeof vi.fn> };
  memory: { create: ReturnType<typeof vi.fn> };
  pendingItem: { create: ReturnType<typeof vi.fn> };
};

const ctx = (parsed: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  parsed,
  now: new Date("2026-01-01T00:00:00Z"),
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DO_NOTHING — a recorded abstention, not a silent no-op", () => {
  it("abstains and records a decision marker", async () => {
    const r = await dispatchAction("DO_NOTHING", ctx({ monologue: "drive low" }), "auto");
    expect(r.outcome).toBe("abstained");
    expect(r.performed).toBe(false);
    expect(db.event.create).toHaveBeenCalledTimes(1);
  });

  it("normalizes nothing / none / empty to an abstention", async () => {
    for (const a of ["nothing", "none", "", "DO_NOTHING", "do_nothing"]) {
      const r = await dispatchAction(a, ctx({}), "auto");
      expect(r.outcome).toBe("abstained");
    }
  });

  it("routes an unknown action to a recorded abstention (never crashes the loop)", async () => {
    const r = await dispatchAction("FLY_TO_MARS", ctx({}), "auto");
    expect(r.outcome).toBe("abstained");
    expect(r.performed).toBe(false);
  });
});

describe("HITL — propose stages, auto commits", () => {
  it("DIARY in propose stages the entry without writing the memory", async () => {
    const r = await dispatchAction("DIARY", ctx({ action_content: "a quiet note" }), "propose");
    expect(r.outcome).toBe("staged");
    expect(r.performed).toBe(false);
    expect(db.memory.create).not.toHaveBeenCalled();
  });

  it("DIARY in auto commits the memory", async () => {
    const r = await dispatchAction("DIARY", ctx({ action_content: "a quiet note" }), "auto");
    expect(r.outcome).toBe("committed");
    expect(r.performed).toBe(true);
    expect(db.memory.create).toHaveBeenCalledTimes(1);
  });

  it("DIARY with empty content is skipped, visibly", async () => {
    const r = await dispatchAction("DIARY", ctx({ action_content: "   " }), "auto");
    expect(r.outcome).toBe("skipped");
    expect(db.memory.create).not.toHaveBeenCalled();
  });

  it("is case-insensitive on the action name", async () => {
    const r = await dispatchAction("diary", ctx({ action_content: "x" }), "auto");
    expect(r.outcome).toBe("committed");
  });
});

describe("WEBSEARCH — curiosity with a pluggable provider", () => {
  it("skips when no query is given", async () => {
    const r = await dispatchAction("WEBSEARCH", ctx({}), "auto");
    expect(r.outcome).toBe("skipped");
  });

  it("skips when no provider is configured (no silent pretend-search)", async () => {
    const r = await dispatchAction("WEBSEARCH", ctx({ query: "pgvector tuning" }), "auto");
    expect(r.outcome).toBe("skipped");
    expect(db.memory.create).not.toHaveBeenCalled();
  });

  it("with a provider in auto, stores results as a memory", async () => {
    const provider: SearchProvider = {
      name: "fake",
      async search() {
        return [{ title: "t", url: "u", snippet: "s" }];
      },
    };
    const r = await dispatchAction("WEBSEARCH", ctx({ query: "pgvector" }, { search: provider }), "auto");
    expect(r.outcome).toBe("committed");
    expect(r.performed).toBe(true);
    expect(db.memory.create).toHaveBeenCalledTimes(1);
  });

  it("with a provider in propose, stages the query without searching", async () => {
    const search = vi.fn(async () => [{ title: "t", snippet: "s" }]);
    const provider: SearchProvider = { name: "fake", search };
    const r = await dispatchAction("WEBSEARCH", ctx({ query: "x" }, { search: provider }), "propose");
    expect(r.outcome).toBe("staged");
    expect(search).not.toHaveBeenCalled();
  });
});

describe("NOTE — always a pending item for human review", () => {
  it("stages a pending item in either mode", async () => {
    const r = await dispatchAction("NOTE", ctx({ action_content: "follow up" }), "auto");
    expect(r.outcome).toBe("staged");
    expect(r.performed).toBe(true);
    expect(db.pendingItem.create).toHaveBeenCalledTimes(1);
  });
});

describe("registry + extension seam", () => {
  it("lists the built-in actions", () => {
    const a = listActions();
    for (const t of ["DIARY", "NOTE", "WEBSEARCH", "EXPLORE", "DO_NOTHING"]) {
      expect(a).toContain(t);
    }
  });

  it("dispatches a custom registered action", async () => {
    let ran = false;
    registerAction({
      type: "PING",
      describe: () => "test ping",
      async run() {
        ran = true;
        return { type: "PING", performed: true, outcome: "committed" as const };
      },
    });
    const r = await dispatchAction("PING", ctx({}), "auto");
    expect(ran).toBe(true);
    expect(r.outcome).toBe("committed");
  });
});

describe("recordScoreFeedback — the diary-score HITL intake", () => {
  it("appends a SCORE_FEEDBACK event", async () => {
    await recordScoreFeedback({ memoryId: "mem_1", userValence: 0.4, selfSnapshot: { valence: 0.7 } });
    expect(db.event.create).toHaveBeenCalledTimes(1);
    const arg = db.event.create.mock.calls[0][0] as { data: { eventType: string } };
    expect(arg.data.eventType).toBe("SCORE_FEEDBACK");
  });
});
