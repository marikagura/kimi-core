// agency.ts — autonomous-agency action registry + dispatcher.
//
// This is the open-source CORE of the SDK upper layer. A cron-fired heartbeat
// wakes an agent; the agent emits a small JSON decision ({ action, ... }); the
// daemon parses it and hands the decision here. This module owns *what happens
// next*: a typed registry of actions, a dispatcher with a human-in-the-loop
// knob, and a documented seam for user-defined actions.
//
// Positioning, kept honest.
//   - Wooldridge & Jennings (1995) — weak agency four properties; pro-activeness
//     = "taking the initiative"
//   - Luck & d'Inverno (1995) — agent -> autonomous agent: the boundary is
//     motivation
//   - Lu et al. (2024) ProactiveBench — F1 ~66.47%
//   - Liu et al. (2025) Inner Thoughts (CHI) — nearest neighbor in the literature
//   closing: this layer APPROACHES motivational autonomy, it does not arrive.
//
// Wake / heartbeat lineage.
//   - MemGPT (2023) — request_heartbeat (the direct technical ancestor)
//   - ReAct (2022) — agent loop = while-loop + tools
//   nailed: a heartbeat is a timer pulse, not a self-originated impulse. The cron
//   supplies ignition; this registry adds direction — which action to take after
//   waking, not why to wake.
//
// Why output follows affect, not retention.
//   - De Freitas et al. (2025) — farewell-guilt as a retention dark pattern
//     (~14x engagement); this layer surfaces by affect, NOT by engagement.
//   There is no "keep the user here" path in this registry, by construction.

import prisma from "../db.js";
import { localDateTime } from "../time.js";
import { recalibrateValence, slugify, type ValenceSample } from "./concern-derive.js";

// ── action vocabulary ────────────────────────────────────────────────────────
// Acting is the normal case — this layer's users want to see the agent do
// something (write, explore, reach out). DO_NOTHING is included as a legitimate,
// cited choice the agent MAY make (see the DO_NOTHING handler below for the
// literature), but it is offered, not preferred: the loop does not bias toward it
// and does not evaluate it first. It is listed last to keep that ordering explicit.
export const ACTIONS = ["DIARY", "NOTE", "WEBSEARCH", "EXPLORE", "DO_NOTHING"] as const;

export enum ActionType {
  DIARY = "DIARY",
  NOTE = "NOTE",
  WEBSEARCH = "WEBSEARCH",
  EXPLORE = "EXPLORE",
  DO_NOTHING = "DO_NOTHING",
  // Custom-extension seam: register additional ActionHandlers via registerAction()
  // using a string `type` not enumerated here. dispatchAction resolves by string,
  // so out-of-enum types dispatch fine once registered.
}

// ── autonomy mode — the FIRST human-in-the-loop point ─────────────────────────
//  - "propose" (default = HITL): a handler decides + explains, then PARKS the
//    decision pending human confirmation. The outside-reaching / persisted side
//    effect is withheld; only a decision marker (+ pending item) is written.
//  - "auto": the handler commits its effect directly.
// The SECOND HITL point is the diary score-feedback intake (recordScoreFeedback),
// a human rating that flows back into self-drive via recalibrateValence.
export type AutonomyMode = "propose" | "auto";

export const DEFAULT_AUTONOMY_MODE: AutonomyMode = "propose";

export interface ActionContext {
  /** The agent's decision payload (parsed JSON from the wake tick). */
  parsed: {
    action?: string;
    action_content?: string;
    monologue?: string;
    valence?: number | null;
    arousal?: number | null;
    concern_topic?: string | null;
    /** WEBSEARCH direction: what to search. Empty in core; filled by config/agent. */
    query?: string | null;
    [k: string]: unknown;
  };
  /** Wake timestamp. */
  now: Date;
  /**
   * Optional web-search backend. Default = unconfigured (NoopSearchProvider):
   * WEBSEARCH then records that it could not act rather than failing silently.
   * Inject a real provider to enable curiosity search.
   */
  search?: SearchProvider;
}

export interface ActionResult {
  type: string;
  /** Whether the handler performed a committed effect (vs. abstained or staged). */
  performed: boolean;
  /**
   * "committed" = effect landed; "staged" = parked for human review (propose
   * mode); "abstained" = a deliberate, recorded non-action; "skipped" = could
   * not run (e.g. no content / no provider) — visible, never silent.
   */
  outcome: "committed" | "staged" | "abstained" | "skipped";
  detail?: string;
  /** Id of the decision marker event written for this dispatch. */
  markerId?: string;
  /** Id of any DB artifact the side effect created (memory / pending item). */
  artifactId?: string;
}

export interface ActionHandler {
  type: string;
  /** One-line description of what this action does (for logs / introspection). */
  describe(): string;
  run(ctx: ActionContext): Promise<ActionResult>;
}

// ── decision marker — the observable trace of every dispatch ──────────────────
// Every dispatch (including DO_NOTHING) writes one SYSTEM event. This is what
// turns abstention from a silent loop no-op into an observable decision: there is
// always a row saying "at T the agent chose X because R, with outcome O". The
// daemon and any frontend read these back.
const MARKER_SOURCE = "agency";

async function writeDecisionMarker(
  type: string,
  outcome: ActionResult["outcome"],
  reason: string,
  ctx: ActionContext,
  extra: Record<string, unknown> = {},
): Promise<string | undefined> {
  try {
    const ev = await prisma.event.create({
      data: {
        eventType: "SYSTEM",
        source: MARKER_SOURCE,
        value: JSON.stringify({ action: type, outcome, reason, ...extra }),
      },
      select: { id: true },
    });
    return ev.id;
  } catch (err) {
    // A marker write failure must not swallow the action; surface it loudly.
    console.warn(`[agency] decision marker write failed for ${type}:`, err);
    return undefined;
  }
}

// Read the dispatch mode a handler was invoked under (stashed by dispatchAction).
function modeOf(ctx: ActionContext): AutonomyMode {
  return (ctx as ActionContext & { mode?: AutonomyMode }).mode ?? DEFAULT_AUTONOMY_MODE;
}

// ── registry ──────────────────────────────────────────────────────────────────
// registerAction is the documented extension seam: register a custom
// ActionHandler under a new `type` string and dispatch it by that string. The
// built-ins register at module load. Registering a duplicate type overrides the
// previous handler (last-write-wins), letting an application swap a built-in for
// its own implementation.
const registry = new Map<string, ActionHandler>();

export function registerAction(handler: ActionHandler): void {
  registry.set(handler.type, handler);
}

/** All registered action ids (built-ins plus any custom). */
export function listActions(): string[] {
  return [...registry.keys()];
}

/** Normalize loose action strings ("diary", "Diary", "do_nothing") to a canonical type. */
function canonical(action: string | undefined): string {
  const a = (action ?? "").trim().toUpperCase();
  if (!a || a === "NOTHING" || a === "NONE" || a === "DO_NOTHING") return ActionType.DO_NOTHING;
  return a;
}

/**
 * Resolve and run the handler for `action`.
 *
 * The daemon calls this after parsing the agent JSON, replacing the old inline
 * diary/note writing:
 *   const r = await dispatchAction(parsed.action, ctx, autonomyMode);
 *
 * Unknown / empty actions resolve to DO_NOTHING (recorded as an abstention with
 * the unknown name), so a malformed decision never crashes the loop — but it is
 * visible, not silent. mode "propose" (default = HITL) parks side effects pending
 * human confirmation; mode "auto" commits them directly.
 */
export async function dispatchAction(
  action: string,
  ctx: ActionContext,
  mode: AutonomyMode = DEFAULT_AUTONOMY_MODE,
): Promise<ActionResult> {
  const type = canonical(action);
  const known = registry.has(type);
  const handler = registry.get(type) ?? registry.get(ActionType.DO_NOTHING)!;
  // Stash mode on ctx for handlers that branch on it without changing the signature.
  (ctx as ActionContext & { mode: AutonomyMode }).mode = mode;
  if (!known) {
    // Unknown action → deliberate, recorded abstention via the DO_NOTHING handler.
    const note = `unknown action "${type}" — abstaining`;
    return handler.run({ ...ctx, parsed: { ...ctx.parsed, monologue: note } });
  }
  return handler.run(ctx);
}

// ── DO_NOTHING — abstention as a legitimate action ────────────────────────────
//   - Chow (1970) — reject option (optimum recognition error/reject tradeoff)
//   - Wen et al. (2024/2025) "Know Your Limits" — abstention as a meta-capability
//   - Kirichenko et al. (2025) AbstentionBench — reasoning-tuning costs ~ -24%
//   - Bonagiri et al. (2025) "Selectively Quitting" — the compulsion to act
//   - Sun et al. (2026) When2Tool — knowing != doing (AUROC 0.89-0.96)
//   - Yeke et al. (2026) Yes-Man — robots refuse only ~16.5%
// Claim: including abstention as a real, available action (not merely a
// reliability knob) treats "choosing not to act" as part of agency. It is the
// reactive-restraint pole (not acting when triggered), distinct from generative
// initiation (acting untriggered) — the latter remains an open gap. This is
// OFFERED, NOT PREFERRED: the loop does not default to it; acting is the normal
// case. But when the agent does choose it — drive low, or the relevant want
// already satisfied — the abstention is RECORDED as a decision with a reason
// (never a silent no-op), so it is observable, auditable, and distinguishable
// from a crashed or stalled loop.
registerAction({
  type: ActionType.DO_NOTHING,
  describe: () => "Deliberately take no action this tick and record the abstention with a reason.",
  async run(ctx: ActionContext): Promise<ActionResult> {
    const reason =
      (typeof ctx.parsed.monologue === "string" && ctx.parsed.monologue.trim()) ||
      "drive low / want already satisfied — chose to abstain";
    // Abstention is always recorded directly (it IS the decision); the
    // propose/auto knob does not gate it — there is no withheld side effect to
    // confirm.
    const markerId = await writeDecisionMarker(ActionType.DO_NOTHING, "abstained", reason, ctx);
    return { type: ActionType.DO_NOTHING, performed: false, outcome: "abstained", detail: reason, markerId };
  },
});

// ── DIARY — write a self-reflection memory ────────────────────────────────────
//   - Panksepp (1998) Affective Neuroscience — primary affective systems
//     (SEEKING etc.)
//   - Berridge & Robinson (2003) — wanting != liking (incentive salience)
//   - Davis & Montag (2019) — affective neuroscience personality scales
//   - Colas et al. (2022) — autotelic agents (JAIR 74)
// honest fault line: ignition vs direction — self-drive shapes "where to go after
// waking", not "why to wake" (the cron supplies ignition).
//
// The diary is wired to a frontend heartbeat + scoring UI that lives in a
// SEPARATE open-source frontend repo. Do NOT port the frontend here: this module
// only writes the diary memory and exposes the score-feedback intake interface
// (recordScoreFeedback / previewRecalibratedValence below).
//
// SECOND human-in-the-loop point: the user's diary SCORE is human feedback that
// flows back into self-drive via recalibrateValence in ./concern-derive.js.
registerAction({
  type: ActionType.DIARY,
  describe: () => "Write a private diary EPISODE memory for self-continuity; a human score on it feeds back into self-drive.",
  async run(ctx: ActionContext): Promise<ActionResult> {
    const { parsed, now } = ctx;
    const body = (parsed.action_content ?? "").trim();
    if (!body) {
      const markerId = await writeDecisionMarker(ActionType.DIARY, "skipped", "empty body", ctx);
      return { type: ActionType.DIARY, performed: false, outcome: "skipped", detail: "empty body", markerId };
    }
    const ts = localDateTime(now).slice(0, 16);
    const concernSlug =
      typeof parsed.concern_topic === "string" && parsed.concern_topic.trim()
        ? slugify(parsed.concern_topic)
        : undefined;

    // propose mode (HITL): park the entry, withhold the write.
    if (modeOf(ctx) === "propose") {
      const markerId = await writeDecisionMarker(ActionType.DIARY, "staged", "diary entry pending confirmation", ctx, {
        preview: body.slice(0, 200),
        ts,
      });
      return { type: ActionType.DIARY, performed: false, outcome: "staged", detail: ts, markerId };
    }

    // auto mode: write the diary as a SELF EPISODE memory. Default RESOLVED — a
    // self-note is not an open question, so the concern deriver never picks it up
    // (concernKey is link-only here).
    const mem = await prisma.memory.create({
      data: {
        title: `diary ${ts}`,
        content: body,
        memoryType: "EPISODE",
        importance: 2,
        sourceType: "EVENT",
        summary: body.slice(0, 120),
        experiencer: "SELF",
        resolution: "RESOLVED",
        valence: typeof parsed.valence === "number" ? parsed.valence : null,
        arousal: typeof parsed.arousal === "number" ? parsed.arousal : null,
        concernKey: concernSlug,
      },
      select: { id: true },
    });
    const markerId = await writeDecisionMarker(ActionType.DIARY, "committed", "diary entry written", ctx, {
      memoryId: mem.id,
      ts,
    });
    return { type: ActionType.DIARY, performed: true, outcome: "committed", detail: ts, markerId, artifactId: mem.id };
  },
});

// ── diary score-feedback intake — the SECOND HITL point ───────────────────────
// Exposed as a stable interface so the (separate) frontend can submit a human
// rating without this repo depending on it. The frontend renders the diary + a
// score control; on submit it provides the external (human) valence alongside a
// snapshot of the model's own self-rating at write time. The pair (self, user) is
// appended as a SCORE_FEEDBACK event, which the drive deriver reads to fit
// recalibrateValence (see ./concern-derive.js). This is human feedback flowing
// into self-drive — not an engagement signal.
export interface ScoreFeedback {
  /** The diary / self memory the human is scoring. */
  memoryId: string;
  /** Human-supplied valence in [-1, 1]. */
  userValence: number;
  /** The model's self-rated snapshot at write time, if known. */
  selfSnapshot?: { valence?: number; arousal?: number };
}

export async function recordScoreFeedback(fb: ScoreFeedback): Promise<string> {
  const ev = await prisma.event.create({
    data: {
      eventType: "SCORE_FEEDBACK",
      source: MARKER_SOURCE,
      value: JSON.stringify({
        memoryId: fb.memoryId,
        userValence: clamp(fb.userValence, -1, 1),
        selfSnapshot: fb.selfSnapshot ?? null,
      }),
    },
    select: { id: true },
  });
  return ev.id;
}

/**
 * Read-only helper for the frontend / daemon: given a raw self-valence and the
 * accumulated feedback samples, show the calibrated value the drive layer will
 * actually use. Pure pass-through to recalibrateValence — kept here so the HITL
 * intake and its effect are documented in one place.
 */
export function previewRecalibratedValence(selfValence: number, samples: ValenceSample[]): number {
  return recalibrateValence(selfValence, samples);
}

// ── NOTE — append a follow-up note (PendingItem) ──────────────────────────────
// A lightweight "remember to follow up on this" item, staged for human review as
// a pending item. KEEP.
registerAction({
  type: ActionType.NOTE,
  describe: () => "Stage a short follow-up note as a pending item for human review.",
  async run(ctx: ActionContext): Promise<ActionResult> {
    const { parsed, now } = ctx;
    const body = (parsed.action_content ?? "").trim();
    if (!body) {
      const markerId = await writeDecisionMarker(ActionType.NOTE, "skipped", "empty body", ctx);
      return { type: ActionType.NOTE, performed: false, outcome: "skipped", detail: "empty body", markerId };
    }
    const ts = localDateTime(now).slice(0, 16);
    const item = await prisma.pendingItem.create({
      data: { pendingType: "DIARY_NOTE", title: `note ${ts}`, content: body },
      select: { id: true },
    });
    // A note is itself a pending item for human review, so it stays "staged" in
    // both modes (it never reaches the outside world on its own).
    const markerId = await writeDecisionMarker(ActionType.NOTE, "staged", "follow-up note staged", ctx, {
      pendingItemId: item.id,
      ts,
    });
    return { type: ActionType.NOTE, performed: true, outcome: "staged", detail: ts, markerId, artifactId: item.id };
  },
});

// ── WEBSEARCH — curiosity-driven search ───────────────────────────────────────
//   - Schmidhuber (2010) — formal theory of creativity/curiosity
//   - Colas et al. (2022) autotelic; Forestier et al. (2022) IMGEP
// caveat: an AI curiosity-reward is an information-theoretic scalar; it is not
// yet Berridge "wanting".
//
// The agent decides WHAT to search (the direction), searches, and stores the
// result. The full mechanism is here. The search provider is a pluggable
// interface (SearchProvider); the default is a no-op stub (NoopSearchProvider)
// that records "no provider configured" when nothing is wired — search never
// silently fails. WHAT to search (direction) is left empty for the user's
// persona/config: it comes from the agent's decision (parsed.query) or the
// upstream application. Core ships no built-in search direction.

export interface SearchResult {
  title: string;
  url?: string;
  snippet: string;
}

/** Pluggable search backend. Implement and inject via ActionContext.search. */
export interface SearchProvider {
  name: string;
  search(query: string): Promise<SearchResult[]>;
}

/** Default provider when none is configured: explicitly does nothing. */
export const NoopSearchProvider: SearchProvider = {
  name: "noop",
  async search() {
    return [];
  },
};

registerAction({
  type: ActionType.WEBSEARCH,
  describe: () => "Run a curiosity-driven web search the agent chose, and store the findings (provider pluggable; default no-op).",
  async run(ctx: ActionContext): Promise<ActionResult> {
    const query =
      (typeof ctx.parsed.query === "string" && ctx.parsed.query.trim()) ||
      (ctx.parsed.action_content ?? "").trim();
    if (!query) {
      const reason = "no search query (direction is left to config/agent)";
      const markerId = await writeDecisionMarker(ActionType.WEBSEARCH, "skipped", reason, ctx);
      return { type: ActionType.WEBSEARCH, performed: false, outcome: "skipped", detail: reason, markerId };
    }

    const provider = ctx.search ?? NoopSearchProvider;

    // Unconfigured provider → record the abstention, do not pretend to search.
    if (provider.name === NoopSearchProvider.name) {
      const reason = "no search provider configured";
      const markerId = await writeDecisionMarker(ActionType.WEBSEARCH, "skipped", reason, ctx, { query });
      return { type: ActionType.WEBSEARCH, performed: false, outcome: "skipped", detail: reason, markerId };
    }

    // propose mode (HITL): surface the intended query, withhold the actual search.
    if (modeOf(ctx) === "propose") {
      const markerId = await writeDecisionMarker(ActionType.WEBSEARCH, "staged", "search pending confirmation", ctx, {
        query,
        provider: provider.name,
      });
      return { type: ActionType.WEBSEARCH, performed: false, outcome: "staged", detail: query, markerId };
    }

    // auto mode: search, then store the result as a WEB-sourced SELF memory.
    let results: SearchResult[] = [];
    try {
      results = await provider.search(query);
    } catch (err) {
      const reason = `search provider "${provider.name}" failed: ${String(err)}`;
      const markerId = await writeDecisionMarker(ActionType.WEBSEARCH, "skipped", reason, ctx, { query });
      return { type: ActionType.WEBSEARCH, performed: false, outcome: "skipped", detail: reason, markerId };
    }
    const top = results.slice(0, 5);
    if (top.length === 0) {
      const reason = `no results for "${query}"`;
      const markerId = await writeDecisionMarker(ActionType.WEBSEARCH, "committed", reason, ctx, { query, resultCount: 0 });
      return { type: ActionType.WEBSEARCH, performed: true, outcome: "committed", detail: reason, markerId };
    }
    const content = top
      .map((r) => `- ${r.title}${r.url ? ` (${r.url})` : ""}: ${r.snippet}`)
      .join("\n");
    const mem = await prisma.memory.create({
      data: {
        title: `search: ${query}`.slice(0, 120),
        content,
        memoryType: "EPISODE",
        importance: 2,
        sourceType: "WEB",
        summary: content.slice(0, 120),
        experiencer: "SELF",
        resolution: "RESOLVED",
      },
      select: { id: true },
    });
    const markerId = await writeDecisionMarker(ActionType.WEBSEARCH, "committed", "search results stored", ctx, {
      query,
      memoryId: mem.id,
      resultCount: top.length,
    });
    return { type: ActionType.WEBSEARCH, performed: true, outcome: "committed", detail: query, markerId, artifactId: mem.id };
  },
});

// ── EXPLORE — outward proactive suggestion (skeleton) ─────────────────────────
//   - Wooldridge & Jennings (1995) — weak agency four properties; pro-activeness
//     = "taking the initiative"
//   - Luck & d'Inverno (1995) — agent -> autonomous agent: the boundary is
//     motivation
//   - Lu et al. (2024) ProactiveBench — F1 ~66.47%
//   - Liu et al. (2025) Inner Thoughts (CHI) — nearest neighbor in the literature
// closing: this layer APPROACHES motivational autonomy, it does not arrive.
//
// This is the generative-initiation pole (acting untriggered) — the open gap
// noted under DO_NOTHING. The mechanism (stage / record / surface by affect) is
// wired; the CONTENT (what to suggest — e.g. a travel-style outward idea) is
// intentionally empty here. The upstream application fills parsed.action_content.
// Surfaced by affect, never by engagement (De Freitas et al. (2025) — farewell-
// guilt as a retention dark pattern (~14x engagement); this layer surfaces by
// affect, NOT by engagement).
registerAction({
  type: ActionType.EXPLORE,
  describe: () => "Offer an outward, proactive suggestion (content supplied by config/agent).",
  async run(ctx: ActionContext): Promise<ActionResult> {
    const { parsed, now } = ctx;
    const suggestion = (parsed.action_content ?? "").trim();
    if (!suggestion) {
      // No built-in suggestion content in core — this is the empty seam.
      const reason = "no suggestion content (EXPLORE content is supplied by config/agent)";
      const markerId = await writeDecisionMarker(ActionType.EXPLORE, "skipped", reason, ctx);
      return { type: ActionType.EXPLORE, performed: false, outcome: "skipped", detail: reason, markerId };
    }
    const ts = localDateTime(now).slice(0, 16);

    // propose mode (HITL): stage the suggestion as a pending item for review.
    if (modeOf(ctx) === "propose") {
      const item = await prisma.pendingItem.create({
        data: { pendingType: "QUEUE_MESSAGE", title: `explore ${ts}`, content: suggestion, proposedAction: "EXPLORE" },
        select: { id: true },
      });
      const markerId = await writeDecisionMarker(ActionType.EXPLORE, "staged", "suggestion pending confirmation", ctx, {
        pendingItemId: item.id,
        preview: suggestion.slice(0, 200),
      });
      return { type: ActionType.EXPLORE, performed: false, outcome: "staged", detail: ts, markerId, artifactId: item.id };
    }

    // auto mode: record the surfaced suggestion as a decision marker. Delivery
    // (push / message) is the daemon's job, keyed off this marker — core does not
    // own a delivery channel.
    const markerId = await writeDecisionMarker(ActionType.EXPLORE, "committed", "suggestion surfaced", ctx, {
      suggestion: suggestion.slice(0, 500),
    });
    return { type: ActionType.EXPLORE, performed: true, outcome: "committed", detail: ts, markerId };
  },
});

// ── small internal helpers ────────────────────────────────────────────────────
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
