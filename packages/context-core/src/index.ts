// @kimi/context-core — one context definition, shared across every surface
// (text chat / voice / web chatroom / agent harness).
//
// Design:
//  - Each surface is one output of the same agent, not a separate system. So the
//    "what to query + how to layer it" logic lives here exactly once; each output
//    (turn-context.ts / chat-memory.ts / chatroom-reentry) is only a thin format layer.
//  - Prisma is injected (not bound to a client): each consumer passes its own client
//    to avoid import-path conflicts and competing connection-pool instances.
//  - surface selects which layers compose into its output. Some layers are gated
//    per surface (each loader documents its own rule); a layer that does not apply
//    to a surface returns null and is skipped.
//  - canMcp: chatroom=true (can self-query via MCP → static light injection ok);
//    tg/voice=false (inject in full — if the push moment under-delivers it cannot be
//    backfilled with a later query).
//
// Layers are loaded independently so any output can compose only the slices it needs:
//   register / anchors / states / observations / episodes / topics / events /
//   profile / entities / digests / persona / merged-chat.

import type { PrismaClient } from "@prisma/client";
import { localDateTime } from "./time.js";
import { CHAT_SOURCE, CROSS_CHAT_SOURCE, COMMIT_SOURCE, COMMIT_EVENT_TYPE, CHAT_DIGEST_WHERE, parseChatEvent, SENSITIVE_TITLE_OR, PRIVATE_TITLE_PREFIX } from "./sources.js";

// Re-export the shared source / event-identity constants + the canonical time
// formatters so the gateway imports them from "@kimi/context-core" rather than
// re-deriving (and drifting from) them.
export * from "./sources.js";
export * from "./time.js";

// tz-naive UTC window width for since-style queries (fed to Prisma `gte`). NOT a
// display value — kept here, not in time.ts (that module is DST/timezone-aware
// formatting; a raw day-width has no business there).
const MS_PER_DAY = 86_400_000;

export type Surface = "cc" | "tg" | "voice" | "chatroom";

export interface ContextOpts {
  surface: Surface;
  /** chatroom=true (can self-query via MCP, light static injection); tg/voice=false
   *  (inject full, cannot backfill later). Note: this is a signal for the output format
   *  layer — the loader does not read it (the loader only branches per surface).
   *  Outputs use it to decide whether a layer renders lean (title/index) or full. */
  canMcp: boolean;
  /** for a gated layer, inject all rows within the last N days (such rows are
   *  infrequent, so windowed by day not by count); default DEFAULT_RECENT_DAYS. */
  recentRestrictedDays?: number;
}

export interface RestrictedItem {
  title: string;
  content: string;
  createdAt: Date;
}

/**
 * a gated layer with three tiers:
 *  - templates: template rows by prefix, always resident in full
 *  - anchors:   anchored rows by id, always resident in full
 *  - recent:    every instance within the recent-day window, full content
 * the cc surface returns null (this layer is not injected there).
 */
export interface RestrictedLayer {
  templates: RestrictedItem[];
  anchors: RestrictedItem[];
  recent: RestrictedItem[];
}

// Anchored rows pinned by id (titles may change, ids do not). Always resident.
// Populate with your own memory ids via config; ships empty.
const RESTRICTED_ANCHOR_IDS: string[] = [];
const DEFAULT_RECENT_DAYS = 20;

// Title prefixes used to identify rows for this layer. Override via config for your own scheme.
const RESTRICTED_TEMPLATE_PREFIX = "[restricted template]";
const RESTRICTED_INSTANCE_PREFIXES: string[] = [];

/**
 * a gated injection layer. One logic, three tiers:
 *  - cc      → null (layer not injected on this surface)
 *  - others  → templates (full) + anchored rows (full) + every recent instance (full)
 */
export async function loadRestrictedLayer(
  prisma: PrismaClient,
  opts: ContextOpts,
): Promise<RestrictedLayer | null> {
  if (opts.surface === "cc") return null; // this layer is not injected on the cc surface

  const days = opts.recentRestrictedDays ?? DEFAULT_RECENT_DAYS;
  const since = new Date(Date.now() - days * MS_PER_DAY);
  const select = { title: true, content: true, createdAt: true } as const;

  const [templates, anchors, recentRaw] = await Promise.all([
    prisma.memory.findMany({
      where: { isActive: true, memoryType: "RESTRICTED", title: { startsWith: RESTRICTED_TEMPLATE_PREFIX } },
      select,
      orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
    }),
    RESTRICTED_ANCHOR_IDS.length
      ? prisma.memory.findMany({
          where: { isActive: true, id: { in: RESTRICTED_ANCHOR_IDS } },
          select,
        })
      : Promise.resolve([] as RestrictedItem[]),
    RESTRICTED_INSTANCE_PREFIXES.length
      ? prisma.memory.findMany({
          where: {
            isActive: true,
            memoryType: "RESTRICTED",
            createdAt: { gte: since },
            OR: RESTRICTED_INSTANCE_PREFIXES.map((p) => ({ title: { startsWith: p } })),
          },
          select,
          orderBy: { createdAt: "desc" },
          // all within the window — such rows are infrequent, no count cap
        })
      : Promise.resolve([] as RestrictedItem[]),
  ]);

  // drop recent rows that duplicate an anchor (so anchors are not double-injected)
  const anchorTitles = new Set(anchors.map((a) => a.title));
  const recent = recentRaw.filter((r) => !anchorTitles.has(r.title));

  return { templates, anchors, recent };
}

// ── register layer (identical across surfaces) ──────────────────────────
export async function loadRegisters(prisma: PrismaClient) {
  return prisma.registerProfile.findMany({
    where: { isActive: true },
    orderBy: { priority: "asc" },
  });
}

// Neutral fallback register defaults, used when no registerProfile rows exist yet.
// These are generic, persona-free dials — override by seeding registerProfile rows.
export interface RegisterDefaults {
  mode: string;
  verbosity: string;
  initiative: string;
  comfort: string;
}
export const registerDefaults: RegisterDefaults = {
  mode: "default",
  verbosity: "balanced",
  initiative: "responsive",
  comfort: "neutral",
};

// ── anchors layer: CORE / BOUNDARY / PREFERENCE top-level invariants ─────
// Threshold is the union of both sides: CORE imp≥4, BOUNDARY imp≥4, PREFERENCE no threshold.
// Excludes [cred_] (credential rows are filtered out) and [private_ (handled by loadPrivate).
export interface AnchorItem {
  memoryType: string;
  title: string;
  summary: string | null;
  content: string;
  importance: number;
}
export async function loadAnchors(prisma: PrismaClient): Promise<AnchorItem[]> {
  return prisma.memory.findMany({
    where: {
      isActive: true,
      NOT: SENSITIVE_TITLE_OR,
      OR: [
        { memoryType: "CORE", importance: { gte: 4 } },
        { memoryType: "BOUNDARY", importance: { gte: 4 } },
        { memoryType: "PREFERENCE" },
      ],
    },
    select: { memoryType: true, title: true, summary: true, content: true, importance: true },
    orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
  });
}

// ── private layer (gated on cc): anchored coreProfile keys + [private_ memories ──
// coreProfile keys that anchor the private layer. Populate via config; ships empty.
const PRIVATE_ANCHOR_KEYS: string[] = [];
export interface PrivateAnchor { key: string; title: string; content: string; importance: number }
export interface PrivateMem { memoryType: string; title: string; content: string; summary: string | null; importance: number }
export interface PrivateLayer { anchors: PrivateAnchor[]; mems: PrivateMem[] }
export async function loadPrivate(prisma: PrismaClient, opts: ContextOpts): Promise<PrivateLayer | null> {
  if (opts.surface === "cc") return null; // this layer is not injected on the cc surface
  const [anchors, mems] = await Promise.all([
    PRIVATE_ANCHOR_KEYS.length
      ? prisma.coreProfile.findMany({
          where: { isActive: true, key: { in: PRIVATE_ANCHOR_KEYS } },
          select: { key: true, title: true, content: true, importance: true },
          orderBy: { importance: "desc" },
        })
      : Promise.resolve([] as PrivateAnchor[]),
    prisma.memory.findMany({
      where: { isActive: true, title: { startsWith: PRIVATE_TITLE_PREFIX } },
      select: { memoryType: true, title: true, content: true, summary: true, importance: true },
      orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
    }),
  ]);
  return { anchors, mems };
}

// ── states layer: full active_state (raw SQL to bypass enum deserialization so an
//    unknown StateType does not throw). Outputs split userStates vs. selfConcerns. ──
export interface StateRow {
  stateType: string;
  title: string;
  content: string | null;
  summary: string | null;
  confidence: number | null;
  startAt: Date;
}
export async function loadStates(prisma: PrismaClient): Promise<StateRow[]> {
  return prisma.$queryRaw<StateRow[]>`
    SELECT "stateType"::text AS "stateType", title, content, summary, confidence, "startAt"
    FROM active_state WHERE "isActive" = true ORDER BY "startAt" DESC`;
}

// ── observations layer (identical across surfaces, full content; output picks title vs content) ──
export interface ObservationItem { subject: string; key: string; title: string; content: string; importance: number }
export async function loadObservations(prisma: PrismaClient): Promise<ObservationItem[]> {
  return prisma.observation.findMany({
    where: { isActive: true, importance: { gte: 4 } },
    select: { subject: true, key: true, title: true, content: true, importance: true },
    orderBy: [{ subject: "asc" }, { importance: "desc" }, { updatedAt: "desc" }],
  });
}

// ── topics layer (identical across surfaces) ──
export interface TopicItem { domain: string; name: string; summary: string | null }
export async function loadTopics(prisma: PrismaClient): Promise<TopicItem[]> {
  const d7 = new Date(Date.now() - 7 * MS_PER_DAY);
  return prisma.topic.findMany({
    where: { status: "ACTIVE", updatedAt: { gte: d7 } },
    orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
    take: 5,
    select: { domain: true, name: true, summary: true },
  });
}

// ── episodes layer: imp5 major events + non-CHAT episodes from the last 7 days ──
export interface EpisodeItem { title: string; summary: string | null; createdAt: Date }
export interface EpisodeLayer { topEps: EpisodeItem[]; recentNonChat: EpisodeItem[] }
export async function loadEpisodes(prisma: PrismaClient): Promise<EpisodeLayer> {
  const d7 = new Date(Date.now() - 7 * MS_PER_DAY);
  const sel = { title: true, summary: true, createdAt: true };
  const [topEps, recentNonChat] = await Promise.all([
    prisma.memory.findMany({
      where: { isActive: true, memoryType: "EPISODE", importance: 5 },
      select: sel, orderBy: { createdAt: "desc" }, take: 5,
    }),
    prisma.memory.findMany({
      where: { isActive: true, memoryType: "EPISODE", importance: { gte: 4 }, createdAt: { gte: d7 }, sourceType: { not: "CHAT" } },
      select: sel, orderBy: { createdAt: "desc" }, take: 5,
    }),
  ]);
  return { topEps, recentNonChat };
}

// ── events layer (surface-aware): git / non-chat activity / cross-surface chat / diary / app ──
// cross-surface direction is mirrored (chatroom reads the primary chat archive, others read the cross-chat archive).
export interface EventRow { eventType: string; source: string | null; value: string | null; createdAt: Date }
export interface EventsLayer { git: EventRow[]; nonChat: EventRow[]; crossChat: EventRow[]; diary: EventRow[]; app: EventRow[] }
export async function loadEvents(prisma: PrismaClient, opts: ContextOpts): Promise<EventsLayer> {
  const now = Date.now();
  const h8 = new Date(now - 8 * 3600000);
  const h12 = new Date(now - 12 * 3600000);
  const sel = { eventType: true, source: true, value: true, createdAt: true };
  const crossSource = opts.surface === "chatroom" ? CHAT_SOURCE : CROSS_CHAT_SOURCE; // read the other surface's chat archive
  const [git, nonChat, crossChat, diary, app] = await Promise.all([
    prisma.event.findMany({ where: { eventType: COMMIT_EVENT_TYPE, source: COMMIT_SOURCE, createdAt: { gte: h8 } }, select: sel, orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.event.findMany({ where: { eventType: { notIn: ["CHAT", "APP_OPEN", "SYSTEM", "DREAM", "MANUAL_NOTE"] }, source: { not: COMMIT_SOURCE }, createdAt: { gte: h12 } }, select: sel, orderBy: { createdAt: "desc" }, take: 15 }),
    prisma.event.findMany({ where: { eventType: "CHAT", source: crossSource }, select: sel, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.event.findMany({ where: { eventType: "DREAM" }, select: sel, orderBy: { createdAt: "desc" }, take: 3 }),
    prisma.event.findMany({ where: { eventType: "APP_OPEN" }, select: sel, orderBy: { createdAt: "desc" }, take: 8 }),
  ]);
  return { git, nonChat, crossChat, diary, app };
}

// ── profile layer (coreProfile, excluding private_ — those go through loadPrivate). Output picks full vs index ──
export interface ProfileItem { key: string; title: string; content: string; importance: number }
export async function loadProfile(prisma: PrismaClient): Promise<ProfileItem[]> {
  return prisma.coreProfile.findMany({
    where: { isActive: true, NOT: { key: { startsWith: "private_" } } },
    select: { key: true, title: true, content: true, importance: true },
    orderBy: [{ importance: "desc" }, { key: "asc" }],
  });
}

// ── entities layer: person cards + projects ──
export interface EntityItem { name: string; summary: string | null }
export interface EntityLayer { persons: EntityItem[]; projects: EntityItem[] }
export async function loadEntities(prisma: PrismaClient): Promise<EntityLayer> {
  const [persons, projects] = await Promise.all([
    prisma.entity.findMany({ where: { status: "ACTIVE", entityType: "PERSON" }, orderBy: { name: "asc" }, select: { name: true, summary: true } }),
    prisma.entity.findMany({ where: { status: "ACTIVE", entityType: "PROJECT" }, orderBy: { name: "asc" }, select: { name: true, summary: true } }),
  ]);
  return { persons, projects };
}

// ── digests layer (voice-only): compressed CHAT episodes, daily versions 7-30 days back ──
export interface DigestItem { title: string; content: string }
export async function loadDigests(prisma: PrismaClient): Promise<DigestItem[]> {
  return prisma.memory.findMany({
    where: { isActive: true, ...CHAT_DIGEST_WHERE },
    orderBy: { digestTimeEnd: "desc" },
    take: 10,
    select: { title: true, content: true },
  });
}

// ── persona layer: text + chatroom share one persona document.
//   No persona ships in this repo. The mechanism reads an external persona document
//   (e.g. persona.md, built by `npm run init`) and composes it with the active register
//   text plus a per-surface opening line. Bring your own content — this returns whatever
//   the injected loader provides, with empty defaults.
//
//   Wire `loadPersonaDoc` to read your persona file (path from config / env), e.g.:
//     readFileSync(process.env.PERSONA_PATH ?? "./persona.md", "utf8")
//   The default below returns "" so the engine runs persona-free out of the box.
export type PersonaSurface = "tg" | "chatroom";

/** Per-surface opening line. Override via config; ships with neutral, content-free defaults. */
export function personaOpening(_surface: PersonaSurface): string {
  // Intentionally empty — supply your own opening line via config / persona.md.
  return "";
}

/** Loads the external persona document body. Default returns "" (no persona shipped). */
export type PersonaDocLoader = () => string;
const emptyPersonaDoc: PersonaDocLoader = () => "";

/**
 * Compose the persona string from external content. Structure preserved so any consumer
 * can swap in its own loader; no persona prose is embedded here.
 */
export function buildPersona(opts: {
  surface: PersonaSurface;
  registersText: string;
  loadPersonaDoc?: PersonaDocLoader;
}): string {
  const doc = (opts.loadPersonaDoc ?? emptyPersonaDoc)();
  const opening = personaOpening(opts.surface);
  // Order: opening line → persona document body → active register text.
  // All content comes from the user's external config; nothing is hardcoded.
  return [opening, doc, opts.registersText].filter(Boolean).join("\n\n");
}

// ── unified cross-surface timeline: text + chatroom as one conversation line ──
export interface MergedChatMsg { id: string; role: "user" | "assistant"; text: string; surface: "tg" | "chat"; at: Date; threadId?: string }
// sinceTs given = anchored mode: pull primary + cross-chat CHAT rows from sinceTs onward, merge by time.
//   The prefix grows append-only (the anchor does not move → stable cached prefix → cache_read hits),
//   unlike a "latest N rows" window that slides off the oldest end and invalidates the cache each turn.
// sinceTs omitted = legacy "latest take rows" mode (other callers may still use it).
// threadId given = restrict to one conversation thread (front-end thread view);
//   omitted = all threads merged into one line (model continuity / reentry).
export async function loadMergedChat(prisma: PrismaClient, take = 40, sinceTs?: Date, threadId?: string): Promise<MergedChatMsg[]> {
  const whereFor = (source: string) => ({
    eventType: "CHAT",
    source,
    ...(sinceTs ? { createdAt: { gte: sinceTs } } : {}),
    // threadId lives inside the JSON value (no schema column) → coarse `contains`
    // pre-filter; the exact match is re-checked after parse below. Build the needle
    // from the SAME JSON encoder used to store it (sources.ts JSON.stringify), so a
    // threadId containing a quote/backslash matches its escaped on-disk form instead
    // of silently returning zero rows (the post-parse guard still narrows exactly).
    ...(threadId ? { value: { contains: `"threadId":${JSON.stringify(threadId)}` } } : {}),
  });
  const fetchTake = sinceTs ? 1500 : take; // anchored mode pulls up to the cap; the caller trims by token budget
  const [tg, web] = await Promise.all([
    prisma.event.findMany({ where: whereFor(CHAT_SOURCE) as never, orderBy: { createdAt: "desc" }, take: fetchTake, select: { id: true, value: true, createdAt: true } }),
    prisma.event.findMany({ where: whereFor(CROSS_CHAT_SOURCE) as never, orderBy: { createdAt: "desc" }, take: fetchTake, select: { id: true, value: true, createdAt: true } }),
  ]);
  const parse = (rows: { id: string; value: string | null; createdAt: Date }[], surface: "tg" | "chat"): MergedChatMsg[] =>
    rows.flatMap((r) => {
      const p = parseChatEvent(r.value);
      if (!p) return [];
      if (threadId && p.threadId !== threadId) return []; // exact-match guard over the coarse filter
      return [{ id: r.id, role: p.role, text: p.text, surface, at: r.createdAt, threadId: p.threadId }];
    });
  // Secondary sort on event id breaks same-millisecond ties deterministically — the
  // cross-device contention case, where two surfaces write within one ms and a
  // createdAt-only sort left the order to concat/sort stability (always tg-before-chat).
  const merged = [...parse(tg, "tg"), ...parse(web, "chat")]
    .sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sinceTs ? merged : merged.slice(-take);
}

// Distinct conversation threads for a front-end history list. Groups recent CHAT
// events by threadId; title = the thread's first user line. Untagged rows (no
// threadId) are skipped — only explicitly threaded conversations are listed.
export interface ChatThread { threadId: string; title: string; lastAt: Date; count: number }
export async function loadChatThreads(
  prisma: PrismaClient,
  opts: { lookbackDays?: number; limit?: number } = {},
): Promise<ChatThread[]> {
  const since = new Date(Date.now() - (opts.lookbackDays ?? 90) * MS_PER_DAY);
  const rows = await prisma.event.findMany({
    where: { eventType: "CHAT", source: { in: [CHAT_SOURCE, CROSS_CHAT_SOURCE] }, createdAt: { gte: since } } as never,
    orderBy: { createdAt: "asc" },
    select: { value: true, createdAt: true },
  });
  const map = new Map<string, { title: string; lastAt: Date; count: number }>();
  for (const r of rows) {
    const p = parseChatEvent(r.value);
    if (!p || !p.threadId) continue;
    const e = map.get(p.threadId);
    if (!e) map.set(p.threadId, { title: p.role === "user" ? p.text.slice(0, 60) : "", lastAt: r.createdAt, count: 1 });
    else {
      e.count++;
      e.lastAt = r.createdAt;
      if (!e.title && p.role === "user") e.title = p.text.slice(0, 60);
    }
  }
  return [...map.entries()]
    .map(([threadId, v]) => ({ threadId, title: v.title, lastAt: v.lastAt, count: v.count }))
    .sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime())
    .slice(0, opts.limit ?? 50);
}

// Merged timeline → API messages: merge consecutive same-role rows (the API requires
// user/assistant alternation), tagging each with [surface time]. The model reads this as
// one cross-surface conversation, not "this surface + a cross-surface background block"
// (the latter steals the reply anchor).
export function formatMergedHistory(merged: MergedChatMsg[]): { role: "user" | "assistant"; content: string }[] {
  const fmt = (d: Date) => localDateTime(d); // KIMI_TZ-aware (default UTC), returns "YYYY-MM-DD HH:MM"
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of merged) {
    const line = `[${m.surface} ${fmt(m.at)}] ${m.text}`;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content += `\n${line}`;
    else out.push({ role: m.role, content: line });
  }
  return out;
}
