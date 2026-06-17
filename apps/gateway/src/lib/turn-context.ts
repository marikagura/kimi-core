// Shared turn-context builder for the messaging webhook + voice surfaces.
//
// Both surfaces feed the model the SAME cache blocks (the persona spine) so the
// assistant identity stays continuous across surfaces. This was previously
// duplicated inline at each call site and the copies HAD to stay byte-identical
// by hand. This helper makes that structural.
//
// The cache blocks (identity / profile / memories / dynamic) are byte-identical
// to the old inline code on a per-surface basis. Surface differences are all
// parameterized through TurnContextOptions, with each surface passing its own
// current value (preserve-exactly, NOT unified):
//   - source                 : history `where.source` + (callers) event writes
//   - identityBuilder         : surface-specific identity block (built externally)
//   - coreEpisodeImportance   : surface A {gte:4} vs surface B 5 (EPISODE clause)
//   - recentEpisodeImportance : surface A {lt:4} vs surface B {lt:5}
//   - includeDigests          : surface B true (extra digest query + section) vs A false
//   - topicNameBold           : surface B **name** vs surface A name
//
// Surface-only logic stays at the call sites (NOT here): routing, allowlist,
// attachment download + splice, history fetch + message assembly, model call,
// cost log label, timestamp strip, send / retry queue, event writes.

import { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { localDate, localDateTime } from "../time.js";
import { loadStates, loadObservations, loadEntities, loadTopics, loadRegisters, loadDigests, loadEvents, loadProfile } from "@kimi/context-core";

export interface TurnContextOptions {
  source: string;
  identityBuilder: (registersText: string) => string;
  coreEpisodeImportance: number | { gte: number }; // surface A {gte:4} / surface B 5
  recentEpisodeImportance: { lt: number };          // surface A {lt:4} / surface B {lt:5}
  includeDigests: boolean;
  topicNameBold: boolean;
}

type SystemBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "1h" } };

export interface TurnContextResult {
  // Cross-turn-stable blocks: identity → profile → memories.
  // 2 cache breakpoints (ttl 1h): profile (covers identity+profile) +
  // memories (covers memories). Remaining breakpoint quota is left for the
  // caller (history uses one).
  //
  // Cache fix: dynamic + time are NOT placed in systemBlocks — they change every
  // turn, and sitting upstream of the caller's history breakpoint would make that
  // breakpoint always miss and bill the whole prefix at the write price. Instead
  // they are returned as dynamicText and the caller injects them into the last
  // user message (downstream of the history breakpoint). The event log stores
  // only the user's raw text; the injected dynamic context is not persisted, so
  // the rebuilt history on the next turn does not contain it and the prefix stays
  // stable.
  systemBlocks: SystemBlock[];
  dynamicText: string;
  localNow: string;
  localWeekday: string;
}

export async function buildTurnContext(opts: TurnContextOptions): Promise<TurnContextResult> {
  // ── DB pulls ───────────────────────────────────────────────────────
  // profile via core loadProfile.
  const profile = await loadProfile(prisma);
  // states via core loadStates (internally uses raw SQL to bypass enum
  // deserialization so an unknown StateType does not throw).
  const allStates = await loadStates(prisma);

  const now = Date.now();
  const d7 = new Date(now - 7 * 86400_000);
  const d1 = new Date(now - 1 * 86400_000);

  // EPISODE lean: previously imp>=4 with no time bound pulled everything, and a
  // month of imp4 (40+ rows) pushed the prompt past 65k. Now imp5 is read in full
  // (~22 rows ≈ 4.4k tok), imp4 only the last 7 days; older imp4 is fetched on
  // demand via search. surface B passes number(5) to keep the original
  // "imp5 only" semantics.
  const episodeClauses: Prisma.MemoryWhereInput[] =
    typeof opts.coreEpisodeImportance === "number"
      ? [{ memoryType: "EPISODE", importance: opts.coreEpisodeImportance }]
      : [
          { memoryType: "EPISODE", importance: 5 },
          { memoryType: "EPISODE", importance: 4, createdAt: { gte: d7 } },
        ];
  const coreAndPref = await prisma.memory.findMany({
    where: {
      isActive: true,
      // [cred_] credentials must not enter the injected context; [private_ is
      // excluded here so it is not duplicated under the 300-char truncation.
      NOT: { OR: [{ title: { startsWith: "[cred_]" } }, { title: { startsWith: "[private_" } }] },
      OR: [
        { memoryType: "CORE", importance: { gte: 4 } },
        { memoryType: "BOUNDARY", importance: { gte: 4 } },
        { memoryType: "PREFERENCE" },
        ...episodeClauses,
      ],
    },
    orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
  });
  const recentEpisodes = await prisma.memory.findMany({
    where: {
      isActive: true,
      memoryType: "EPISODE",
      importance: opts.recentEpisodeImportance,
      sourceType: { not: "CHAT" },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const recentMemories = [...coreAndPref, ...recentEpisodes];

  // digests: surface-B only (surface A omits — includeDigests false). via core loadDigests.
  const digests = opts.includeDigests ? await loadDigests(prisma) : [];

  const observations = await loadObservations(prisma);

  const entityLayer = await loadEntities(prisma);
  const personEntities = entityLayer.persons;
  const projectEntities = entityLayer.projects;

  const activeTopics = await loadTopics(prisma);

  // events via @kimi/context-core shared layer (surface-aware).
  // Note: loadEvents.nonChat excludes DREAM/MANUAL_NOTE (they have their own
  // diary/git columns), so "recent activity" omits DREAM — DREAM goes to the
  // diary block, APP_OPEN goes to the app block. Cross-surface history is merged
  // via loadMergedChat at the call site, so events.crossChat is not rendered here.
  const events = await loadEvents(prisma, { surface: "tg", canMcp: false });
  const recentNonChatEvents = events.nonChat;
  const gitEvents = events.git;
  const fmtTs = (d: Date) => localDateTime(new Date(d));
  const diaryText = events.diary.map((e) => `- [${fmtTs(e.createdAt)}] ${(e.value || "").replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
  const appText = events.app.map((e) => `- [${fmtTs(e.createdAt)}] ${(e.value || "").split("\n")[0].slice(0, 100)}`).join("\n");

  const episodeImportant = await prisma.memory.findMany({
    where: {
      isActive: true,
      memoryType: "EPISODE",
      importance: { gte: 4 },
      createdAt: { gte: d7 },
    },
    orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
    take: 2,
  });
  const episodeRecent = await prisma.memory.findMany({
    where: {
      isActive: true,
      memoryType: "EPISODE",
      createdAt: { gte: d1 },
    },
    orderBy: { createdAt: "desc" },
    take: 2,
  });
  const memoriesIds = new Set(recentMemories.map((m: any) => m.id));
  const seen = new Set<string>();
  const dynEpisodes = [...episodeImportant, ...episodeRecent].filter((m: any) => {
    if (seen.has(m.id) || memoriesIds.has(m.id)) return false;
    seen.add(m.id);
    return true;
  }).slice(0, 4);

  // self-concern states are an internal-only background layer; they are split out
  // and rendered separately (never suppressed, never sliced).
  const userStates = allStates.filter((s: any) => s.stateType !== "SELF_CONCERN");
  const selfConcerns = allStates.filter((s: any) => s.stateType === "SELF_CONCERN");

  // ── Text formatting ─────────────────────────────────────────────────
  const profileText = profile.map((p: any) => `- ${p.title}: ${p.content}`).join("\n");
  const SUMMARY_ONLY_STATES = ["PROJECT"];
  const statesText = userStates.map((s: any) => {
    if (SUMMARY_ONLY_STATES.includes(s.stateType)) {
      return `- [${s.stateType}] ${s.title}: ${s.summary || s.content?.slice(0, 200)}`;
    }
    return `- [${s.stateType}] ${s.title}: ${s.content}`;
  }).join("\n");
  const selfConcernsText = selfConcerns.map((s: any) => `- ${s.title}: ${s.content}`).join("\n");
  const memoriesText = recentMemories.map((m: any) => `- [${m.memoryType}] ${m.title}: ${(m.summary || m.content).slice(0, 300)}`).join("\n");
  const digestsText = digests.map((d: any) => `- ${d.title}: ${d.content}`).join("\n");

  const allRegisters = await loadRegisters(prisma);

  const registersText = allRegisters.map((r: any) =>
    `### ${r.name} (priority=${r.priority}, mode=${r.mode})
- verbosity: ${r.verbosityStyle}, initiative: ${r.initiativeStyle}, comfort: ${r.comfortStyle}
- tone: ${r.toneKeywords || "-"}
- forbidden: ${r.forbiddenPhrases || "-"}
- preferred: ${r.preferredPhrases || "-"}
- triggerConditions: ${r.triggerConditions ? JSON.stringify(r.triggerConditions) : "-"}
${r.exampleSnippets ? `- example: ${r.exampleSnippets}` : ""}`
  ).join("\n\n");

  // ── Block assembly ──────────────────────────────────────────────────
  // identity — surface-specific block, built externally and passed in verbatim.
  // Persona prose itself is supplied through external config (see context-core
  // buildPersona, which returns the empty default unless a persona doc is set).
  const blockIdentity = opts.identityBuilder(registersText);

  const obsHer = observations
    .filter((o: any) => o.subject === "user")
    .map((o: any) => `- **${o.title}** (${o.key}): ${o.content}`)
    .join("\n");
  const obsClaude = observations
    .filter((o: any) => o.subject === "self")
    .map((o: any) => `- **${o.title}** (${o.key}): ${o.content}`)
    .join("\n");

  const blockProfile = `## About the user
${profileText}

## Observations about the user (importance>=4)
${obsHer || "- none"}

## Observations about the assistant (importance>=4)
${obsClaude || "- none"}

## People (entities the user mentioned; nicknames/descriptions also resolve)
${personEntities.length > 0 ? personEntities.map((e: any) => `- **${e.name}**${e.summary ? `: ${e.summary}` : ""}`).join("\n") : "- none"}

## Projects the user is working on (titles only; details via active_state / topic / memory)
${projectEntities.length > 0 ? projectEntities.map((e: any) => `- ${e.name}`).join("\n") : "- none"}`;

  // memories: surface A "recent memories" only; surface B appends a digest section.
  const blockMemories = opts.includeDigests
    ? `## Recent memories
${memoriesText}

## Recent episode recall (7-30 days ago, daily-compressed)
${digestsText || "- none"}`
    : `## Recent memories
${memoriesText}`;

  const topicsText = activeTopics
    .map((t: any) =>
      opts.topicNameBold
        ? `- [${t.domain}] **${t.name}**${t.summary ? `: ${t.summary}` : ""}`
        : `- [${t.domain}] ${t.name}${t.summary ? `: ${t.summary}` : ""}`
    )
    .join("\n");
  const eventsText = recentNonChatEvents
    .map((e: any) => {
      const ts = localDateTime(new Date(e.createdAt));
      const firstLine = (e.value || "").split("\n")[0].slice(0, 150);
      return `- [${ts}] ${e.eventType}: ${firstLine}`;
    })
    .join("\n");
  const dynEpisodesText = dynEpisodes
    .map((m: any) => {
      const ts = localDate(new Date(m.createdAt));
      return `- [${ts}] ${m.title}${m.summary ? `: ${m.summary}` : ""}`;
    })
    .join("\n");

  const gitText = gitEvents
    .map((e: any) => {
      const ts = localDateTime(new Date(e.createdAt));
      const v = (e.value || "").replace(/^git:\s*/, "");
      return `- [${ts}] ${v}`;
    })
    .join("\n");

  // Calendar injection was removed in the clean-room build (no calendar client).
  // The section header is kept as an empty placeholder so the block shape is
  // stable; wire a calendar source back in here if desired.
  const calendarText = "";

  let blockDynamic = `## Current user state
${statesText || "- none"}

## What the user is working on (active topics, stable across sleep)
${topicsText || "- none"}

## Upcoming 24h calendar
${calendarText || "- none"}

## Recent git pushes (last 8h, top 10, scheduler */30min)
${gitText || "- none"}

## Recent activity (non-chat events, last 12h)
${eventsText || "- none"}

## Recent memories (last few days; cross-session / cross-sleep context)
${dynEpisodesText || "- none"}

## Assistant diary (autonomous-wake notes)
${diaryText || "- none"}

## Which app the user is in (latest APP_OPEN)
${appText || "- none"}`;
  if (selfConcerns.length > 0) {
    blockDynamic += `\n\n## Assistant background state (do not surface verbatim)\n${selfConcernsText}`;
  }

  // ── Time block (no cache; always fresh) ─────────────────────────────
  // Datetime + weekday both honor the configured display timezone (KIMI_TZ,
  // default UTC). Formatting is routed through ./time.js; the weekday is derived
  // in the same timezone via Intl so the two never disagree.
  const localNow = localDateTime(new Date());
  const localWeekday = new Intl.DateTimeFormat("en-US", {
    timeZone: process.env.KIMI_TZ || "UTC",
    weekday: "short",
  }).format(new Date());

  // ttl 1h: messages can be 5min-1h apart; a default 5min TTL would rewrite the
  // prefix several times an hour. A 1h TTL only pays the write price for the
  // first message after a long gap.
  //
  // Breakpoint layout: the provider caps breakpoints at 4. The system prefix is
  // collapsed from 4 blocks into 2 — B1 on profile (covers identity+profile),
  // B2 on memories (covers memories) — leaving 1 breakpoint for history (the
  // caller attaches it to the second-to-last message) plus 1 spare. Cost: when
  // profile changes alone it forces a rewrite of memories too, but both rarely
  // change, so this is acceptable.
  const TTL_1H = { type: "ephemeral", ttl: "1h" } as const;
  // The system prefix keeps only cross-turn-stable blocks. dynamic + time go
  // through dynamicText into the last user message — see the TurnContextResult
  // comment (the history breakpoint upstream must not hold volatile bytes).
  const systemBlocks: SystemBlock[] = [
    { type: "text", text: blockIdentity },
    { type: "text", text: blockProfile,  cache_control: TTL_1H },
    { type: "text", text: blockMemories, cache_control: TTL_1H },
  ];
  const dynamicText = `${blockDynamic}\n\nNow: ${localNow} (${localWeekday})`;

  return { systemBlocks, dynamicText, localNow, localWeekday };
}
