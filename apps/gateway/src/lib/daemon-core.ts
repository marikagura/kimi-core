// daemon-core — pieces shared by the wake daemon (daemon.ts) and any sibling
// wake loop. Two concerns live here:
//   1. ensureSubscriptionAuth: force the SDK onto the subscription OAuth token by
//      clearing API-key env vars that would otherwise override it.
//   2. buildGroundTruth: a generic "what is the user doing right now" snapshot,
//      pre-computed from recent events and fed into the top of the wake prompt so
//      the agent does not have to go fetch it.
//
// Source-name config: the event sources this reads (chat surface, hook/loop
// heartbeats, commit stream, etc.) are NOT hard-coded — they come from env so a
// deployment can map them onto its own ingestion surfaces. This module injects
// no private content: ground truth is activity *signals* (timing, counts,
// schedule), never message bodies of sensitive content.

import "dotenv/config";
import prisma from "../db.js";
import { localDate, localDateTime } from "../time.js";

// Clear API-key env vars that would shadow the subscription token, forcing the
// SDK to authenticate via CLAUDE_CODE_OAUTH_TOKEN (subscription plan limit).
export function ensureSubscriptionAuth() {
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY"]) {
    if (process.env[k]) {
      delete process.env[k];
      console.warn(`[daemon-core] removed ${k} (would shadow subscription auth)`);
    }
  }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error("CLAUDE_CODE_OAUTH_TOKEN not set — run `claude setup-token` first");
  }
}

// ── event-source names (config-driven) ─────────────────────────────────────
// Map these onto your own ingestion surfaces. Defaults are generic placeholders.
//  - CHAT_SOURCE        : primary conversational surface (event.source for CHAT)
//  - CROSS_CHAT_SOURCE  : a second conversational surface to merge in (optional)
//  - HOOK_SOURCE        : interactive client heartbeat (real presence)
//  - LOOP_SOURCE        : background loop heartbeat (NOT presence — excluded)
//  - COMMIT_SOURCE      : code-commit activity stream
const CHAT_SOURCE = process.env.GROUND_CHAT_SOURCE ?? "chat";
const CROSS_CHAT_SOURCE = process.env.GROUND_CROSS_CHAT_SOURCE ?? "chat_b";
const HOOK_SOURCE = process.env.GROUND_HOOK_SOURCE ?? "client_hook";
const LOOP_SOURCE = process.env.GROUND_LOOP_SOURCE ?? "client_loop";
const COMMIT_SOURCE = process.env.GROUND_COMMIT_SOURCE ?? "git_commit";

// ── ground truth: what the user is doing right now (pre-computed for the prompt).
//    Shared so sibling wake loops stay in sync. The commit window is a fixed
//    recent-24h span (surface-independent). Everything here is context, not a
//    gate — the daemon never holds output based on it.
export async function buildGroundTruth(now: Date): Promise<string> {
  const nowMs = now.getTime();
  const ago = (d: Date) => {
    const m = Math.round((nowMs - d.getTime()) / 60000);
    if (m < 60) return `${m}min ago`;
    return `${(m / 60).toFixed(1)}h ago`;
  };
  const stamp = (d: Date) => localDateTime(d);
  const todayKey = localDate(now);
  const yestKey = localDate(new Date(nowMs - 24 * 3600_000));

  // commit window = last 24h (fixed; independent of any per-surface wake marker).
  const windowStart = new Date(nowMs - 24 * 3600_000);

  // Sequential queries, not concurrent — share a small DB connection pool; favor
  // stability over latency here.
  const commits = await prisma.event.findMany({ where: { eventType: "SYSTEM", source: COMMIT_SOURCE, createdAt: { gte: windowStart } }, orderBy: { createdAt: "desc" }, take: 40 });
  const lastHook = await prisma.event.findFirst({ where: { eventType: "APP_OPEN", source: HOOK_SOURCE }, orderBy: { createdAt: "desc" } });
  // True device activity = app-open. Exclude the interactive hook heartbeat and
  // the background loop heartbeat — neither is the user picking up a device.
  const lastApp = await prisma.event.findFirst({ where: { eventType: "APP_OPEN", source: { notIn: [HOOK_SOURCE, LOOP_SOURCE] } }, orderBy: { createdAt: "desc" } });
  const lastChat = await prisma.event.findFirst({ where: { eventType: "CHAT" }, orderBy: { createdAt: "desc" } });
  // External calendar namespace (config-driven): maps onto a deployment's own
  // calendar ingestion KV partition. Defaults to a generic placeholder.
  const calNamespace = process.env.CAL_NAMESPACE ?? "calendar-external";
  const gcalToday = await prisma.pwaKv.findFirst({ where: { namespace: calNamespace, key: todayKey } });
  const calRows = await prisma.pwaKv.findMany({ where: { namespace: "calendar", key: { in: [todayKey, yestKey] } } });
  // Pull recent rows from both conversational surfaces (cross-surface awareness).
  const primaryMsgs = await prisma.event.findMany({ where: { eventType: "CHAT", source: CHAT_SOURCE }, orderBy: { createdAt: "desc" }, take: 20 });
  const crossMsgs = await prisma.event.findMany({ where: { eventType: "CHAT", source: CROSS_CHAT_SOURCE }, orderBy: { createdAt: "desc" }, take: 20 });
  // Recent non-chat EPISODE memories (deeper sessions not captured as CHAT events).
  // Exclude this daemon's own diary entries.
  const recentDeep = await prisma.memory.findMany({
    where: {
      isActive: true, memoryType: "EPISODE",
      createdAt: { gte: new Date(nowMs - 3 * 24 * 3600_000) },
      NOT: [{ title: { startsWith: "diary" } }],
    },
    orderBy: { createdAt: "desc" }, take: 8,
    select: { title: true, summary: true, createdAt: true },
  });

  // Real human-presence signals: commit / chat / device app-open / interactive hook.
  // The background loop heartbeat is deliberately excluded above so a paper/digest
  // loop ticking on the hour is not misread as "the user is active".
  const realActs: { src: string; at: Date }[] = [];
  if (lastApp) realActs.push({ src: "device", at: lastApp.createdAt });
  if (commits[0]) realActs.push({ src: "commit", at: commits[0].createdAt });
  if (lastChat) realActs.push({ src: "chat", at: lastChat.createdAt });
  if (lastHook) realActs.push({ src: "client", at: lastHook.createdAt });
  realActs.sort((a, b) => b.at.getTime() - a.at.getTime());
  const lastReal = realActs[0];
  const gapMin = lastReal ? Math.round((nowMs - lastReal.at.getTime()) / 60000) : 9999;

  const recentCommit = commits[0] && nowMs - commits[0].createdAt.getTime() < 45 * 60000;
  const recentChat = lastChat && nowMs - lastChat.createdAt.getTime() < 30 * 60000;
  const clientActive = lastHook && nowMs - lastHook.createdAt.getTime() < 30 * 60000;
  let inferred: string;
  if (recentCommit) inferred = "probably coding (just shipped — commit is the first signal)";
  else if (recentChat) inferred = "in conversation (chatted within 30min)";
  else if (clientActive) inferred = "active in the interactive client (hook heartbeat within 30min)";
  else if (gapMin < 30) inferred = "online (recent real activity: device / commit / chat)";
  else if (gapMin > 180) inferred = "probably asleep (no real activity for a long time)";
  else inferred = "uncertain (intermittent activity)";

  const calMap: Record<string, any> = {};
  for (const r of calRows) calMap[r.key] = r.payload;

  const L: string[] = [];
  L.push(`## User right now · ground truth (context, not a gate — output is never held on this)`);
  L.push(`- inferred: ${inferred}  ·  last real activity ${lastReal ? `${lastReal.src} ${ago(lastReal.at)}` : "none"}`);
  if (commits.length) {
    L.push(`- commits (last 24h: ${commits.length} · first signal · grounding only, do not report progress):`);
    for (const c of commits.slice(0, 12)) {
      let msg = "", repo = "";
      try { const v = JSON.parse(c.value || "{}"); msg = v.message || ""; repo = v.repo || ""; } catch { /* skip */ }
      L.push(`    [${stamp(c.createdAt)}] ${repo}${repo ? ": " : ""}${msg}`);
    }
    if (commits.length > 12) L.push(`    …and ${commits.length - 12} more`);
  } else {
    L.push(`- commits: none in the last 24h — not coding`);
  }
  L.push(`- client hook: ${lastHook ? `last ${ago(lastHook.createdAt)} (interactive window — background loop runs under a separate source)` : "none recently"}  ·  device app: ${lastApp ? `${(lastApp.value || "").slice(0, 36)} ${ago(lastApp.createdAt)}` : "none"}`);
  let sched = "(empty)";
  try {
    const evs: any[] = (gcalToday?.payload as any)?.events || [];
    if (evs.length) sched = evs.map((e) => `${e.time || ""} ${e.title || ""}${e.location ? ` @${e.location}` : ""}`.trim()).join(" / ").slice(0, 220);
  } catch { /* skip */ }
  L.push(`- today's schedule: ${sched}`);

  // Merge recent rows from both conversational surfaces, newest first, tagged by
  // surface. Open-source ground truth injects activity signals only — message
  // text is summarized to a short prefix, never expanded with private content.
  const renderChat = (m: any, tag: string) => {
    let text = "", who = "user";
    try { const v = JSON.parse(m.value || "{}"); text = v.text || ""; who = v.role === "assistant" ? "self" : "user"; }
    catch { text = m.value || ""; }
    // Strip inline timestamp blocks ([... HH:MM]) that get embedded in message text.
    const norm = text.replace(/\[[^\]]*?\d{1,2}[:.]\d{2}[^\]]*?\]/g, "").replace(/\s+/g, " ").trim();
    return { at: m.createdAt.getTime(), line: `- ${tag} ${who}: ${norm.slice(0, 100)}` };
  };
  const convo = [
    ...primaryMsgs.map((m) => renderChat(m, "[chat]")),
    ...crossMsgs.map((m) => renderChat(m, "[chat-b]")),
  ].sort((a, b) => b.at - a.at);
  if (convo.length) {
    L.push(`\n## Recent conversation (${primaryMsgs.length} + ${crossMsgs.length} rows, newest first)`);
    for (const c of convo) L.push(c.line);
  }
  if (recentDeep.length) {
    L.push(`\n## Recent sessions (last 3 days; trailing timestamp ≈ when written)`);
    for (const m of recentDeep) L.push(`- ${m.title.slice(0, 44)}: ${(m.summary || "").slice(0, 80)}  ·  ${stamp(m.createdAt)}`);
  }
  return L.join("\n");
}
