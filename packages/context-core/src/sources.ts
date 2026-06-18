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
export const CHAT_DIGEST_WHERE = { memoryType: "EPISODE", sourceType: "CHAT", experiencer: "SHARED" } as const;

// Stored CHAT event.value shape + decode. role "assistant" ⇒ the AI ("self").
export interface ChatEventValue { role: "user" | "assistant"; text: string }
export function parseChatEvent(
  value: string | null,
): { role: "user" | "assistant"; text: string; who: "user" | "self" } | null {
  try {
    const o = JSON.parse(value || "{}");
    if (typeof o.text !== "string" || !o.text) return null;
    const role = o.role === "assistant" ? "assistant" : "user";
    return { role, text: o.text, who: role === "assistant" ? "self" : "user" };
  } catch {
    return null;
  }
}
