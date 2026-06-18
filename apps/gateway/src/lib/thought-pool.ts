// Thought pool — stateless, event-sourced.
// Salience is recomputed from the THOUGHT_HIT event log on read (ACT-R
// base-level activation), with zero mutable counters. "Resolution" is marked by
// an append-only THOUGHT_RESOLVED event (permanent, not derived from a sliding
// window — that avoids active/resolved oscillation).
//
// Parameters were empirically tuned for behavior before wiring in:
//   d=0.5 gives the best separation; fixation threshold B≈0.4 (a single stray
//   hit sits below B=0, repeated hits climb above B>0.7); the spacing guard
//   (span >= 1 day) stops a burst of dense chatter from fixating instantly.
//
// Tunables read from env with neutral defaults (see config.example.yaml
// thoughtPool.*).

import prisma from "../db.js";
import { numEnv } from "./env.js";

const D = numEnv("THOUGHT_DECAY_D", 0.5);            // ACT-R decay
const FIX_THRESHOLD = numEnv("THOUGHT_FIX_THRESHOLD", 0.4); // B over this + below → fixation
const SPACING_MIN_DAYS = numEnv("THOUGHT_SPACING_MIN_DAYS", 1); // span guard
const FIX_MIN_HITS = numEnv("THOUGHT_FIX_MIN_HITS", 3); // at least N hits to count as repeated
const FIX_RESOLVE_DAYS = numEnv("THOUGHT_FIX_RESOLVE_DAYS", 3); // fixation held long enough → resolve
const HARD_TIMEOUT_DAYS = numEnv("THOUGHT_HARD_TIMEOUT_DAYS", 30); // hard timeout: force-resolve past this

// Source-shape bias guard: weight each hit by its origin. A model-internal
// ("self_voice") source defaults to 0.5 as a placeholder — once enough
// recalibration samples accrue, derive this from the model's measured tendency
// to over-rate its own preferred-shape content.
const SOURCE_WEIGHT: Record<string, number> = (() => {
  try {
    const raw = process.env.THOUGHT_SOURCE_WEIGHTS;
    if (raw) return JSON.parse(raw);
  } catch {
    /* fall through to defaults */
  }
  return { user: 1.0, external: 0.6, self_voice: 0.5 };
})();

export type ThoughtHit = { at: Date; source: string };

export type ThoughtState = {
  key: string;
  B: number;
  isFixation: boolean;
  driveBoost: number; // amount fed back to the matching dimension (0 = none)
  shouldResolve: boolean; // should write a THOUGHT_RESOLVED event
};

// ACT-R base-level: B = ln(Σ wⱼ · ageⱼ^(-d)). age in days, floored at 1h so a
// just-recorded hit (age→0) doesn't blow up.
export function baseLevel(hits: ThoughtHit[], now: Date, d = D): number {
  if (hits.length === 0) return -Infinity;
  let sum = 0;
  for (const h of hits) {
    const ageDays = Math.max((now.getTime() - h.at.getTime()) / 86400000, 1 / 24);
    const w = SOURCE_WEIGHT[h.source] ?? 0.5;
    sum += w * Math.pow(ageDays, -d);
  }
  return Math.log(sum);
}

function spanDays(hits: ThoughtHit[]): number {
  if (hits.length < 2) return 0;
  const ts = hits.map((h) => h.at.getTime());
  return (Math.max(...ts) - Math.min(...ts)) / 86400000;
}

// Compute a thought's current state from its hit log. resolved=true (a
// RESOLVED event already exists) → it no longer boosts any drive.
export function thoughtState(key: string, hits: ThoughtHit[], resolved: boolean, now: Date): ThoughtState {
  const B = baseLevel(hits, now, D);
  if (resolved) return { key, B, isFixation: false, driveBoost: 0, shouldResolve: false };
  const span = spanDays(hits);
  const firstAge = hits.length
    ? (now.getTime() - Math.min(...hits.map((h) => h.at.getTime()))) / 86400000
    : 0;
  // fixation: B over threshold + genuinely repeated (span >= 1 day, blocks dense
  // chatter) + at least N hits
  const isFixation = B > FIX_THRESHOLD && span >= SPACING_MIN_DAYS && hits.length >= FIX_MIN_HITS;
  // drive_boost: only a fixation feeds back, graded, capped at 0.3
  const driveBoost = isFixation ? Math.min(0.3, (B - FIX_THRESHOLD) * 0.15) : 0;
  // resolve: fixation held long enough, or hard timeout
  const shouldResolve = (isFixation && firstAge >= FIX_RESOLVE_DAYS) || firstAge >= HARD_TIMEOUT_DAYS;
  return { key, B, isFixation, driveBoost, shouldResolve };
}

// Pull all THOUGHT_HIT events for a key + whether it's already RESOLVED.
// Stateless: everything is recomputed from the event log.
export async function loadThought(key: string, now: Date = new Date()): Promise<ThoughtState> {
  const [hitRows, resolvedRow] = await Promise.all([
    prisma.event.findMany({
      where: { eventType: "THOUGHT_HIT", value: key, createdAt: { lte: now } },
      select: { source: true, createdAt: true },
    }),
    prisma.event.findFirst({ where: { eventType: "THOUGHT_RESOLVED", value: key }, select: { id: true } }),
  ]);
  const hits: ThoughtHit[] = hitRows.map((r) => ({ at: r.createdAt, source: r.source ?? "self_voice" }));
  return thoughtState(key, hits, !!resolvedRow, now);
}

// Append one hit (called by the producing side). Only count genuinely new
// stimuli, not read/scoring actions.
export async function recordThoughtHit(key: string, source: string): Promise<void> {
  await prisma.event.create({ data: { eventType: "THOUGHT_HIT", value: key, source } });
}

// Write the resolution marker (append-only, permanent).
export async function resolveThought(key: string): Promise<void> {
  await prisma.event.create({ data: { eventType: "THOUGHT_RESOLVED", value: key, source: "thought_pool" } });
}

// Aggregate every thought's drive_boost by dimension. THOUGHT_HIT.value encodes
// "dim:rawkey". Returns Map<dim, totalBoost> (each dim capped at 0.3). The drive
// deriver adds this to the matching dimension's confidence (only lifting dims
// that already have grounding>0 — never conjuring one). Empty Map = no change.
export async function driveBoostByDim(now: Date = new Date()): Promise<Map<string, number>> {
  const [hitRows, resolvedRows] = await Promise.all([
    prisma.event.findMany({
      where: { eventType: "THOUGHT_HIT", createdAt: { lte: now } },
      select: { value: true, source: true, createdAt: true },
    }),
    prisma.event.findMany({ where: { eventType: "THOUGHT_RESOLVED" }, select: { value: true } }),
  ]);
  const resolved = new Set(resolvedRows.map((r) => r.value));
  const byKey = new Map<string, ThoughtHit[]>();
  for (const r of hitRows) {
    if (!r.value) continue;
    if (!byKey.has(r.value)) byKey.set(r.value, []);
    byKey.get(r.value)!.push({ at: r.createdAt, source: r.source ?? "self_voice" });
  }
  const boostByDim = new Map<string, number>();
  for (const [key, hits] of byKey) {
    const st = thoughtState(key, hits, resolved.has(key), now);
    if (st.driveBoost > 0) {
      const dim = key.includes(":") ? key.split(":")[0] : "_nodim";
      boostByDim.set(dim, Math.min(0.3, (boostByDim.get(dim) ?? 0) + st.driveBoost));
    }
  }
  return boostByDim;
}
