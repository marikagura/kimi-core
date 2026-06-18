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
import { CHAT_SOURCE, CROSS_CHAT_SOURCE, HOOK_SOURCE, LOOP_SOURCE, COMMIT_SOURCE, COMMIT_EVENT_TYPE, parseChatEvent } from "@kimi/context-core";

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

// Event-source names + the commit eventType come from the shared sources module
// (@kimi/context-core/sources) so every reader — daemon, drives, intel, the
// context builders — agrees on them. Map them onto your surfaces via the GROUND_*
// env vars there.

// Recency window (hours) within which the chat surfaces count as the *current*
// conversation. A wake loop ticks every several hours; once the latest chat
// message falls outside this window those rows are history, not what the user
// "just said" — feeding them in undated lets the wake loop quote days-old
// messages as current. Tunable via env.
const CHAT_LIVE_WINDOW_H = Number(process.env.GROUND_CHAT_LIVE_WINDOW_H ?? 36);

// ── ground truth: what the user is doing right now (pre-computed for the prompt).
//    Shared so sibling wake loops stay in sync. The commit window is a fixed
//    recent-24h span (surface-independent). Everything here is context, not a
//    gate — the daemon never holds output based on it.
export async function buildGroundTruth(now: Date): Promise<string> {
  const nowMs = now.getTime();
  const ago = (d: Date) => {
    const m = Math.round((nowMs - d.getTime()) / 60000);
    if (m < 60) return `${m}min ago`;
    if (m < 48 * 60) return `${(m / 60).toFixed(1)}h ago`;
    return `${(m / 1440).toFixed(1)} days ago`;
  };
  const stamp = (d: Date) => localDateTime(d);
  const todayKey = localDate(now);
  const yestKey = localDate(new Date(nowMs - 24 * 3600_000));

  // commit window = last 24h (fixed; independent of any per-surface wake marker).
  const windowStart = new Date(nowMs - 24 * 3600_000);

  // Sequential queries, not concurrent — share a small DB connection pool; favor
  // stability over latency here.
  const commits = await prisma.event.findMany({ where: { eventType: COMMIT_EVENT_TYPE, source: COMMIT_SOURCE, createdAt: { gte: windowStart } }, orderBy: { createdAt: "desc" }, take: 40 });
  const lastHook = await prisma.event.findFirst({ where: { eventType: "APP_OPEN", source: HOOK_SOURCE }, orderBy: { createdAt: "desc" } });
  // True device activity = app-open. Exclude the interactive hook heartbeat and
  // the background loop heartbeat — neither is the user picking up a device.
  const lastApp = await prisma.event.findFirst({ where: { eventType: "APP_OPEN", source: { notIn: [HOOK_SOURCE, LOOP_SOURCE] } }, orderBy: { createdAt: "desc" } });
  // (last real chat message is derived below from the actual message surfaces,
  // not a broad eventType:"CHAT" query — see lastChatAt)
  // External calendar namespace (config-driven): maps onto a deployment's own
  // calendar ingestion KV partition. Defaults to a generic placeholder.
  const calNamespace = process.env.CAL_NAMESPACE ?? "calendar-external";
  const gcalToday = await prisma.pwaKv.findFirst({ where: { namespace: calNamespace, key: todayKey } });
  const calRows = await prisma.pwaKv.findMany({ where: { namespace: "calendar", key: { in: [todayKey, yestKey] } } });
  // Pull recent rows from both conversational surfaces (cross-surface awareness).
  const primaryMsgs = await prisma.event.findMany({ where: { eventType: "CHAT", source: CHAT_SOURCE }, orderBy: { createdAt: "desc" }, take: 20 });
  const crossMsgs = await prisma.event.findMany({ where: { eventType: "CHAT", source: CROSS_CHAT_SOURCE }, orderBy: { createdAt: "desc" }, take: 20 });
  // Last real chat message, from the message surfaces only — NOT a broad
  // eventType:"CHAT" query (closeout / digest / other non-message events also land
  // as CHAT and would falsely read as "the user just messaged").
  const lastPrimaryAt = primaryMsgs[0]?.createdAt ?? null;
  const lastCrossAt = crossMsgs[0]?.createdAt ?? null;
  const lastChatAt = [lastPrimaryAt, lastCrossAt].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
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
  if (lastChatAt) realActs.push({ src: "chat", at: lastChatAt });
  if (lastHook) realActs.push({ src: "client", at: lastHook.createdAt });
  realActs.sort((a, b) => b.at.getTime() - a.at.getTime());
  const lastReal = realActs[0];
  const gapMin = lastReal ? Math.round((nowMs - lastReal.at.getTime()) / 60000) : 9999;

  const recentCommit = commits[0] && nowMs - commits[0].createdAt.getTime() < 45 * 60000;
  const recentChat = lastChatAt && nowMs - lastChatAt.getTime() < 30 * 60000;
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
    const p = parseChatEvent(m.value);
    // Fall back to the raw value as text if it isn't the {role,text} JSON shape.
    const text = p?.text ?? (m.value || "");
    const who = p?.who ?? "user";
    // Strip inline timestamp blocks ([... HH:MM]) that get embedded in message text.
    const norm = text.replace(/\[[^\]]*?\d{1,2}[:.]\d{2}[^\]]*?\]/g, "").replace(/\s+/g, " ").trim();
    // Pin each line with its own event time. The normalizer above strips any inline
    // [HH:MM] block from the body, so without this the whole block carries no time
    // signal and days-old rows read as just-said.
    return { at: m.createdAt.getTime(), line: `- [${stamp(m.createdAt).slice(5)}] ${tag} ${who}: ${norm.slice(0, 100)}` };
  };
  // Time-flow gate: feed the chat rows in as "current conversation" only when the
  // latest message is within the live window. If the user has been active only on
  // another surface for a while, these rows are history — dumping them undated lets
  // the wake loop quote days-old messages as if just said. Outside the window, emit
  // one time-flow line instead of the rows.
  const liveCut = nowMs - CHAT_LIVE_WINDOW_H * 3600_000;
  const chatIsLive = !!(lastChatAt && lastChatAt.getTime() >= liveCut);
  if (chatIsLive) {
    const convo = [
      ...primaryMsgs.filter((m) => m.createdAt.getTime() >= liveCut).map((m) => renderChat(m, "[chat]")),
      ...crossMsgs.filter((m) => m.createdAt.getTime() >= liveCut).map((m) => renderChat(m, "[chat-b]")),
    ].sort((a, b) => b.at - a.at);
    L.push(`\n## Recent conversation (chat surfaces · within last ${CHAT_LIVE_WINDOW_H}h · newest first)`);
    for (const c of convo) L.push(c.line);
  } else {
    L.push(`\n## Chat surfaces · time flow — no chat-surface message in the last ${CHAT_LIVE_WINDOW_H}h`);
    L.push(`- last ${CHAT_SOURCE} ${lastPrimaryAt ? ago(lastPrimaryAt) : "—"}  ·  last ${CROSS_CHAT_SOURCE} ${lastCrossAt ? ago(lastCrossAt) : "—"}. Treat older chat rows as history, not as just-said.`);
  }
  if (recentDeep.length) {
    L.push(`\n## Recent sessions (last 3 days; trailing timestamp ≈ when written)`);
    for (const m of recentDeep) L.push(`- ${m.title.slice(0, 44)}: ${(m.summary || "").slice(0, 80)}  ·  ${stamp(m.createdAt)}`);
  }
  return L.join("\n");
}
