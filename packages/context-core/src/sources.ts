// Canonical event-source names + event identities — the ONE definition shared by
// context-core and the gateway (daemon, drives, intel, context builders), so every
// reader/writer queries the SAME rows. Source names resolve from one env var set
// (GROUND_*); map them onto your ingestion surfaces. Defaults are generic.

export const CHAT_SOURCE = process.env.GROUND_CHAT_SOURCE ?? "chat";            // primary conversational surface
export const CROSS_CHAT_SOURCE = process.env.GROUND_CROSS_CHAT_SOURCE ?? "chat_b"; // a second surface to merge in
export const HOOK_SOURCE = process.env.GROUND_HOOK_SOURCE ?? "client_hook";     // interactive client heartbeat (presence)
export const LOOP_SOURCE = process.env.GROUND_LOOP_SOURCE ?? "client_loop";     // background loop heartbeat (NOT presence)
export const COMMIT_SOURCE = process.env.GROUND_COMMIT_SOURCE ?? "git_commit";  // code-commit activity stream

// Commit activity is logged as MANUAL_NOTE events (they carry their own git
// columns). One canonical eventType so every reader queries the same rows — not
// SYSTEM in one place and MANUAL_NOTE in another.
export const COMMIT_EVENT_TYPE = "MANUAL_NOTE" as const;

// A digested chat session is identified as EPISODE + CHAT + SHARED. One predicate
// so the digest writer and every reader agree on what a "chat digest" row is.
// CHAT_DIGEST_SHARED is the (sourceType, experiencer) pair on its own, used both to
// build CHAT_DIGEST_WHERE and as the `NOT:` exclusion in the generic-episode readers.
export const CHAT_DIGEST_SHARED = { sourceType: "CHAT", experiencer: "SHARED" } as const;
export const CHAT_DIGEST_WHERE = { memoryType: "EPISODE", ...CHAT_DIGEST_SHARED } as const;

// Stored CHAT event.value shape + decode. role "assistant" ⇒ the AI ("self").
export interface ChatEventValue { role: "user" | "assistant"; text: string }
export function parseChatEvent(
  value: string | null,
): { role: "user" | "assistant"; text: string; who: "user" | "self"; threadId?: string } | null {
  try {
    const o = JSON.parse(value || "{}");
    if (typeof o.text !== "string" || !o.text) return null;
    const role = o.role === "assistant" ? "assistant" : "user";
    return { role, text: o.text, who: role === "assistant" ? "self" : "user", threadId: typeof o.threadId === "string" ? o.threadId : undefined };
  } catch {
    return null;
  }
}

// Validate a write-boundary threadId to a safe charset + length. The read-side
// coarse pre-filter searches for the threadId inside the JSON value; an unbounded /
// arbitrary-character threadId (e.g. derived from a title or URL) risks pathological
// filters and oversized keys. Returns null when absent; throws on a malformed value
// so the caller can reject the write (400) rather than store an unreadable thread.
const THREAD_ID_RE = /^[A-Za-z0-9._-]+$/;
export function validateThreadId(threadId: unknown): string | null {
  if (threadId == null || threadId === "") return null;
  if (typeof threadId !== "string" || threadId.length > 128 || !THREAD_ID_RE.test(threadId)) {
    throw new Error("threadId must be 1-128 chars of [A-Za-z0-9._-]");
  }
  return threadId;
}

// Encode a CHAT event.value from a role + text — the counterpart to parseChatEvent.
// One definition so every writer (POST /chat, the chat_write tool) stores the SAME
// shape that parseChatEvent / loadMergedChat read.
export function buildChatEventValue(
  role: string,
  text: string,
  opts: { threadId?: string; maxLen?: number } = {},
): string {
  const v: { role: "user" | "assistant"; text: string; threadId?: string } = {
    role: role === "assistant" ? "assistant" : "user",
    text: text.slice(0, opts.maxLen ?? 8000),
  };
  if (opts.threadId) v.threadId = opts.threadId;
  return JSON.stringify(v);
}

// Title prefixes for sensitive memories that must never enter injected context.
// [cred_] = credentials; [private_ = the private pool (surfaced only via loadPrivate).
export const CRED_TITLE_PREFIX = "[cred_]";
export const PRIVATE_TITLE_PREFIX = "[private_";
// Prisma OR clause matching either prefix — used as `NOT: SENSITIVE_TITLE_OR` to
// keep both out of any injected surface. ONE definition so the readers (loadAnchors,
// turn-context) can't drift: a prefix added here closes every injection path at once.
export const SENSITIVE_TITLE_OR = {
  OR: [{ title: { startsWith: CRED_TITLE_PREFIX } }, { title: { startsWith: PRIVATE_TITLE_PREFIX } }],
};
