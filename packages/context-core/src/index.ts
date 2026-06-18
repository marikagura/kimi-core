// @kimi/context-core — one context definition, shared across every surface
// (text chat / voice / web chatroom / agent harness).
//
// Design:
//  - Each surface is one output of the same agent, not a separate system. So the
//    "what to query + how to layer it" logic lives here exactly once; each output
//    (turn-context.ts / chat-memory.ts / chatroom-reentry) is only a thin format layer.
//  - Prisma is injected (not bound to a client): each consumer passes its own client
//    to avoid import-path conflicts and competing connection-pool instances.
//  - surface decides harness visibility (NOT private vs. public):
//      cc      → model-harness visible → filter restricted/private (the only filtered case)
//      tg/voice/chatroom → only reachable after auth → full payload incl. restricted/private
//      (any public-facing denylist is a separate path and does not go through this core)
//  - canMcp: chatroom=true (can self-query via MCP → static light injection ok);
//    tg/voice=false (inject in full — if the push moment under-delivers it cannot be
//    backfilled with a later query).
//
// Layers: restricted / register / private / anchors / states / observations / episodes /
//   topics / events / profile / entities / digests / persona / merged-chat. Each layer
//   is loaded independently so any output can compose only the slices it needs.

import type { PrismaClient } from "@prisma/client";
import { localDateTime } from "./time.js";
import { CHAT_SOURCE, CROSS_CHAT_SOURCE, COMMIT_SOURCE, COMMIT_EVENT_TYPE, CHAT_DIGEST_WHERE, parseChatEvent, SENSITIVE_TITLE_OR, PRIVATE_TITLE_PREFIX } from "./sources.js";

// Re-export the shared source / event-identity constants + the canonical time
// formatters so the gateway imports them from "@kimi/context-core" rather than
// re-deriving (and drifting from) them.
export * from "./sources.js";
export * from "./time.js";

export type Surface = "cc" | "tg" | "voice" | "chatroom";

export interface ContextOpts {
  surface: Surface;
  /** chatroom=true (can self-query via MCP, light static injection); tg/voice=false
   *  (inject full, cannot backfill later). Note: this is a signal for the output format
   *  layer — the loader does not read it (the loader only branches the cc filter on
   *  surface). Outputs use it to decide whether a layer renders lean (title/index) or full. */
  canMcp: boolean;
  /** inject all restricted rows within the last N days (restricted content is infrequent,
   *  windowed by day not by count); default DEFAULT_RECENT_DAYS. */
  recentRestrictedDays?: number;
}

export interface RestrictedItem {
  title: string;
  content: string;
  createdAt: Date;
}

/**
 * the restricted layer has three tiers:
 *  - templates: restricted templates (voice / mode / arc pattern), always resident in full
 *  - anchors:   anchored arcs by id, always resident in full
 *  - recent:    every instance within the recent-day window, full content
 * cc surface returns null (harness visible, restricted content never enters).
 */
export interface RestrictedLayer {
  templates: RestrictedItem[];
  anchors: RestrictedItem[];
  recent: RestrictedItem[];
}

// Anchored restricted memories pinned by id (titles may change, ids do not). Always resident.
// Populate with your own memory ids via config; ships empty.
const RESTRICTED_ANCHOR_IDS: string[] = [];
const DEFAULT_RECENT_DAYS = 20;

// Title prefixes used to identify restricted rows. Override via config for your own scheme.
const RESTRICTED_TEMPLATE_PREFIX = "[restricted template]";
const RESTRICTED_INSTANCE_PREFIXES: string[] = [];

/**
 * restricted injection layer. One logic, three visibility tiers:
 *  - cc      → null (harness visible, no restricted content)
 *  - others  → templates (full) + anchored arcs (full) + every recent instance (full)
 */
export async function loadRestrictedLayer(
  prisma: PrismaClient,
  opts: ContextOpts,
): Promise<RestrictedLayer | null> {
  if (opts.surface === "cc") return null; // harness visible → restricted content does not enter cc

  const days = opts.recentRestrictedDays ?? DEFAULT_RECENT_DAYS;
  const since = new Date(Date.now() - days * 86400000);
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
          // all within the window — restricted content is infrequent, no count cap
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
// Excludes [cred_] (credentials never enter the injection surface) and [private_ (loadPrivate).
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

// ── private layer (filtered out on cc): anchored coreProfile keys + [private_ memories ──
// coreProfile keys that anchor the private layer. Populate via config; ships empty.
const PRIVATE_ANCHOR_KEYS: string[] = [];
export interface PrivateAnchor { key: string; title: string; content: string; importance: number }
export interface PrivateMem { memoryType: string; title: string; content: string; summary: string | null; importance: number }
export interface PrivateLayer { anchors: PrivateAnchor[]; mems: PrivateMem[] }
export async function loadPrivate(prisma: PrismaClient, opts: ContextOpts): Promise<PrivateLayer | null> {
  if (opts.surface === "cc") return null; // harness visible → private content does not enter cc
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
  const d7 = new Date(Date.now() - 7 * 86400000);
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
  const d7 = new Date(Date.now() - 7 * 86400000);
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
export interface MergedChatMsg { role: "user" | "assistant"; text: string; surface: "tg" | "chat"; at: Date }
// sinceTs given = anchored mode: pull primary + cross-chat CHAT rows from sinceTs onward, merge by time.
//   The prefix grows append-only (the anchor does not move → stable cached prefix → cache_read hits),
//   unlike a "latest N rows" window that slides off the oldest end and invalidates the cache each turn.
// sinceTs omitted = legacy "latest take rows" mode (other callers may still use it).
export async function loadMergedChat(prisma: PrismaClient, take = 40, sinceTs?: Date): Promise<MergedChatMsg[]> {
  const whereFor = (source: string) =>
    sinceTs
      ? { eventType: "CHAT", source, createdAt: { gte: sinceTs } }
      : { eventType: "CHAT", source };
  const fetchTake = sinceTs ? 1500 : take; // anchored mode pulls up to the cap; the caller trims by token budget
  const [tg, web] = await Promise.all([
    prisma.event.findMany({ where: whereFor(CHAT_SOURCE) as never, orderBy: { createdAt: "desc" }, take: fetchTake, select: { value: true, createdAt: true } }),
    prisma.event.findMany({ where: whereFor(CROSS_CHAT_SOURCE) as never, orderBy: { createdAt: "desc" }, take: fetchTake, select: { value: true, createdAt: true } }),
  ]);
  const parse = (rows: { value: string | null; createdAt: Date }[], surface: "tg" | "chat"): MergedChatMsg[] =>
    rows.flatMap((r) => {
      const p = parseChatEvent(r.value);
      if (!p) return [];
      return [{ role: p.role, text: p.text, surface, at: r.createdAt }];
    });
  const merged = [...parse(tg, "tg"), ...parse(web, "chat")].sort((a, b) => a.at.getTime() - b.at.getTime());
  return sinceTs ? merged : merged.slice(-take);
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
