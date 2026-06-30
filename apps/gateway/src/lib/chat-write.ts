// Shared CHAT-event write path for POST /chat and the chat_write tool, so the two
// cross-device entry points can't drift on validation or idempotency.
//
// Idempotency wires the Event.dedupeKey column (schema.prisma) so a retried send —
// the request succeeded server-side but the response was lost on a flaky mobile
// link, so the client resends — is a no-op returning the original row instead of a
// second identical CHAT row that would render twice and feed the digest twice. The
// @@unique([eventType, dedupeKey]) migration makes the guard structural; we still
// check-first to return the existing id, and catch the unique-violation to win the
// race between two concurrent retries.

import { Prisma, EventType } from "@prisma/client";
import prisma from "../db.js";
import { CHAT_SOURCE, buildChatEventValue, validateThreadId } from "@kimi/context-core";

export interface ChatWriteInput {
  role?: string;
  text: string;
  threadId?: string;
  source?: string;
  /** Client-supplied idempotency key — a retry with the same key returns the original row. */
  dedupeKey?: string;
}

export interface ChatWriteResult {
  id: string;
  at: Date;
  /** true when this call matched an existing dedupeKey row (no new insert happened). */
  deduped: boolean;
}

/**
 * Validate + write one CHAT event. Throws on a bad threadId (caller maps to 400);
 * dedups on dedupeKey when supplied. Caller must have already checked text is a
 * non-empty string.
 */
export async function writeChatEvent(input: ChatWriteInput): Promise<ChatWriteResult> {
  const threadId = validateThreadId(input.threadId) ?? undefined; // throws on malformed
  const dedupeKey = input.dedupeKey && input.dedupeKey.trim() ? input.dedupeKey.trim().slice(0, 200) : null;
  const data = {
    eventType: EventType.CHAT,
    value: buildChatEventValue(input.role ?? "user", input.text, { threadId }),
    source: input.source && input.source.trim() ? input.source.trim().slice(0, 80) : CHAT_SOURCE,
    dedupeKey,
  };

  if (dedupeKey) {
    // Fast path: a prior insert with this key already landed → return it unchanged.
    const existing = await prisma.event.findFirst({
      where: { eventType: EventType.CHAT, dedupeKey },
      select: { id: true, createdAt: true },
    });
    if (existing) return { id: existing.id, at: existing.createdAt, deduped: true };
  }

  try {
    const ev = await prisma.event.create({ data, select: { id: true, createdAt: true } });
    return { id: ev.id, at: ev.createdAt, deduped: false };
  } catch (err) {
    // Lost the race: a concurrent retry inserted the same (eventType, dedupeKey)
    // between our check and create. Re-read and return that row instead of failing.
    if (dedupeKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.event.findFirst({
        where: { eventType: EventType.CHAT, dedupeKey },
        select: { id: true, createdAt: true },
      });
      if (existing) return { id: existing.id, at: existing.createdAt, deduped: true };
    }
    throw err;
  }
}
