import { describe, it, expect, beforeAll, afterAll } from "vitest";
import prisma from "./db.js";
import {
  buildChatEventValue,
  parseChatEvent,
  loadMergedChat,
  loadChatThreads,
  CHAT_SOURCE,
  CROSS_CHAT_SOURCE,
} from "@kimi/context-core";

// DB integration — the chat-sync + threading path behind cross-device chat:
// per-message CHAT events (POST /chat / chat_write) → merged read (chat_read /
// loadMergedChat) → thread list (chat_threads / loadChatThreads). Local DB only.
const local = process.env.DATABASE_URL?.includes("localhost") ? describe : describe.skip;

local("I — chat-sync + threading (cross-device)", () => {
  const tag = `verify-${Date.now()}`;
  const A = `${tag}-A`;
  const B = `${tag}-B`;
  const base = Date.now() - 3600_000; // 1h ago, so the rows sit inside the lookback window
  const t = (n: number) => new Date(base + n * 60_000); // ordered, 1 min apart

  // write a CHAT event the same way POST /chat / chat_write do
  const writeChat = (role: "user" | "assistant", text: string, threadId: string, source: string, at: Date) =>
    prisma.event.create({
      data: { eventType: "CHAT", value: buildChatEventValue(role, text, { threadId }), source, createdAt: at },
    });

  beforeAll(async () => {
    // thread A — two "devices" on the primary surface + one cross-surface message,
    // interleaved in time, to prove same-source multi-device AND cross-surface merge:
    await writeChat("user", "A1 from device-1", A, CHAT_SOURCE, t(1));
    await writeChat("user", "A2 from device-2", A, CHAT_SOURCE, t(2)); // 2nd device, same source
    await writeChat("user", "A3 from cross-surface", A, CROSS_CHAT_SOURCE, t(3)); // other surface
    await writeChat("assistant", "A4 reply", A, CHAT_SOURCE, t(4));
    // thread B — a separate conversation
    await writeChat("user", "B1 only", B, CHAT_SOURCE, t(5));
  });

  afterAll(async () => {
    await prisma.event.deleteMany({ where: { eventType: "CHAT", value: { contains: tag } } });
    await prisma.$disconnect();
  });

  it("encodes + decodes threadId (buildChatEventValue ⇄ parseChatEvent)", () => {
    const p = parseChatEvent(buildChatEventValue("assistant", "hi", { threadId: "x" }));
    expect(p).toEqual({ role: "assistant", text: "hi", who: "self", threadId: "x" });
  });

  it("reads one thread, merged across devices + surfaces, in time order", async () => {
    const a = await loadMergedChat(prisma, 50, undefined, A);
    expect(a.map((m) => m.text)).toEqual([
      "A1 from device-1",
      "A2 from device-2",
      "A3 from cross-surface",
      "A4 reply",
    ]);
    expect(a.every((m) => m.threadId === A)).toBe(true);
    // both the primary surface (tg) and the cross surface (chat) are present → merged
    expect(new Set(a.map((m) => m.surface))).toEqual(new Set(["tg", "chat"]));
    // thread B does not leak into thread A
    expect(a.some((m) => m.text.startsWith("B"))).toBe(false);
  });

  it("reads all threads merged when no threadId is given", async () => {
    const all = await loadMergedChat(prisma, 200);
    const texts = all.map((m) => m.text);
    expect(texts).toContain("A1 from device-1");
    expect(texts).toContain("B1 only");
  });

  it("lists distinct threads with title + count (chat_threads)", async () => {
    const threads = await loadChatThreads(prisma, { lookbackDays: 1, limit: 200 });
    const ta = threads.find((x) => x.threadId === A);
    const tb = threads.find((x) => x.threadId === B);
    expect(ta?.count).toBe(4);
    expect(ta?.title).toBe("A1 from device-1"); // first user line is the thread title
    expect(tb?.count).toBe(1);
  });
});
