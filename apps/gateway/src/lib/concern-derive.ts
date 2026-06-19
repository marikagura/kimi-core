// self-concern engine — derive() is the sole writer that projects
// Memory(SELF concern) into ActiveState SELF_CONCERN. Idempotent, can be rebuilt
// from Memory at any time → drift self-heals.
//
// It only owns the rows it created (source="derive"). Legacy hand-set rows
// (source!=derive) are left alone.

import prisma from "../db.js";
import { numEnv } from "./env.js";
import { driveBoostByDim } from "./thought-pool.js";
import { localDate } from "../time.js";
import { CHAT_SOURCE, CROSS_CHAT_SOURCE } from "@kimi/context-core";
import { firstJsonObject } from "./json-extract.js";

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^\w一-龥]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24) || "untitled"
  );
}

export interface DeriveResult {
  upserted: number;
  deactivated: number;
  keys: string[];
}

// self-score → concern: recurrence gate. A concern backed purely by SELF_SCORE
// must "recur across multiple days" before it surfaces — a single bad session
// does not stand up a concern. Mixing in any non-self-score backing (a
// hand-written STATE etc.) = a deliberately written concern, no gate (keeps the
// original behavior). Tunables read from env (see config.example.yaml concern.*).
const SS_NEG_VALENCE = numEnv("CONCERN_SS_NEG_VALENCE", -0.2); // threshold for self-score "negative"
const SS_STRONG_NEG = numEnv("CONCERN_SS_STRONG_NEG", -0.6); // strong negative: rare hard signal, stands up same-day (bypasses the gate)
const SS_MIN_COUNT = numEnv("CONCERN_SS_MIN_COUNT", 2); // weak negatives need at least N under the same key
const SS_MIN_DAYS = numEnv("CONCERN_SS_MIN_DAYS", 2); // across at least N distinct calendar days

// Recurrence gate for self-score concerns. A strong single negative (v <=
// SS_STRONG_NEG) surfaces immediately; weak negatives need >= SS_MIN_COUNT across
// >= SS_MIN_DAYS distinct days (counted in the configured timezone via localDate).
// `negs` = the self-scores under one concern key, already filtered to negative
// valence. Pure + exported so the load-bearing gate is unit-tested.
export function recurrenceMet(
  negs: { valence: number | null; validFrom?: Date | null; createdAt: Date }[],
): boolean {
  if (negs.length === 0) return false;
  if (negs.some((m) => (m.valence ?? 0) <= SS_STRONG_NEG)) return true;
  const days = new Set(negs.map((m) => localDate(m.validFrom ?? m.createdAt)));
  return negs.length >= SS_MIN_COUNT && days.size >= SS_MIN_DAYS;
}
const humanizeKey = (k: string) => k.replace(/^(ss_|cc_)/, "").replace(/_/g, " ");

// Memory(SELF, OPEN/EASING, concernKey) → ActiveState SELF_CONCERN.
export async function deriveConcerns(opts: { dryRun?: boolean } = {}): Promise<DeriveResult> {
  const dryRun = opts.dryRun ?? false;

  const mems = await prisma.memory.findMany({
    where: {
      experiencer: "SELF",
      resolution: { in: ["OPEN", "EASING"] },
      isActive: true,
      concernKey: { not: null },
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      summary: true,
      content: true,
      valence: true,
      arousal: true,
      memoryType: true,
      concernKey: true,
      resolution: true,
      createdAt: true,
      validFrom: true,
    },
  });

  // Gather all backing per concernKey (mems is updatedAt desc, so [0] = most recent).
  const byKeyAll = new Map<string, typeof mems>();
  for (const m of mems) {
    if (!m.concernKey) continue;
    const arr = byKeyAll.get(m.concernKey) ?? [];
    arr.push(m);
    byKeyAll.set(m.concernKey, arr);
  }

  // Pick a representative + apply the recurrence gate: a key backed purely by
  // self-score needs >= SS_MIN_COUNT negatives across >= SS_MIN_DAYS days.
  // startByKey: a self-score concern's band is drawn from its EARLIEST failure
  // (not the most recent).
  const repByKey = new Map<string, (typeof mems)[number]>();
  const startByKey = new Map<string, Date>();
  for (const [key, list] of byKeyAll) {
    if (list.every((m) => m.memoryType === "SELF_SCORE")) {
      const negs = list.filter((m) => (m.valence ?? 0) <= SS_NEG_VALENCE);
      // recurrence not met → don't surface (the memory stays OPEN as evidence).
      // Day counting (localDate, KIMI_TZ) + thresholds live in recurrenceMet.
      if (!recurrenceMet(negs)) continue;
      startByKey.set(
        key,
        negs.reduce((a, m) => {
          const d = m.validFrom ?? m.createdAt;
          return d < a ? d : a;
        }, negs[0].validFrom ?? negs[0].createdAt),
      );
    }
    repByKey.set(key, list[0]);
  }

  // derive is the sole authority over ALL active SELF_CONCERN ActiveStates:
  // upsert keyed-Memory-backed ones, deactivate the rest (legacy hand-set / old
  // source / backing lost). This auto-clears legacy rows and guards against
  // duplicate rows a stale process may have created (next derive self-cleans).
  const allActive = await prisma.activeState.findMany({
    where: { stateType: "SELF_CONCERN", isActive: true },
  });
  const derivedByKey = new Map<string, (typeof allActive)[number]>();
  for (const s of allActive) if (s.source === "derive" && s.sourceKey) derivedByKey.set(s.sourceKey, s);

  let upserted = 0;
  let deactivated = 0;

  // upsert active concerns
  for (const [key, rep] of repByKey) {
    const data = {
      // self-score-backed concerns derive a readable title from the key
      title: rep.memoryType === "SELF_SCORE" ? `concern · ${humanizeKey(key)}` : rep.title,
      summary: rep.summary ?? rep.content.slice(0, 200),
      content: rep.content,
      confidence: rep.arousal ?? 0.5, // felt-weight (axis 2)
      sourceMemoryId: rep.id,
      isActive: true,
      endAt: null as Date | null,
    };
    if (dryRun) {
      upserted++;
      continue;
    }
    const existing = derivedByKey.get(key);
    if (existing) {
      // update without touching startAt (a concern's start point is stable)
      await prisma.activeState.update({ where: { id: existing.id }, data });
    } else {
      // create: startAt = the backing memory's event date validFrom, so the band
      // is drawn from the concern's true start. validFrom is the event-occurred
      // date written by the digest loop; falls back to createdAt.
      await prisma.activeState.create({
        data: { stateType: "SELF_CONCERN", source: "derive", sourceKey: key, startAt: startByKey.get(key) ?? rep.validFrom ?? rep.createdAt, ...data },
      });
    }
    upserted++;
  }

  // deactivate any active row no current keyed Memory backs (legacy / old source / stale)
  for (const s of allActive) {
    const stillBacked = s.source === "derive" && !!s.sourceKey && repByKey.has(s.sourceKey);
    if (!stillBacked) {
      if (!dryRun) {
        await prisma.activeState.update({
          where: { id: s.id },
          data: { isActive: false, endAt: new Date() },
        });
      }
      deactivated++;
    }
  }

  return { upserted, deactivated, keys: [...repByKey.keys()] };
}

// ── LLM closeout sweep ──────────────────────────────────────────────────────
// The only LLM-spending concern step: scan OPEN+EASING SELF concerns, and for
// each thread let an LLM judge resolved / active / linger, writing back
// resolution. derive is a pure logical projection and never closes a concern on
// its own — closeout must come from this step. Scheduled before derive in the
// daily pipeline so verdicts land in the same run's projection.
//
// callLLM is injected by the caller — this lib holds no key and selects no
// model, staying side-effect-free so tools can dryRun it without triggering any
// daemon.
export type SweepLLM = (system: string, user: string) => Promise<string>;
export type SweepVerdict = {
  key: string;
  states: string; // OPEN / EASING / OPEN/EASING
  verdict: "resolved" | "active" | "linger";
  evidence: string;
  titles: string[];
  memCount: number;
  applied: boolean; // actually wrote the DB (dryRun=false, verdict != linger, rows changed)
};

// Pure, unit-tested: turn a self-sweep LLM response into a verdict. A misparse
// (empty / no JSON / parse error / unknown verdict) MUST default to "linger" —
// never "resolved" / "active" — so a broken key can't silently close or reopen
// a concern. The empty-response console.warn stays at the call site.
export function parseSweepVerdict(raw: string): { verdict: SweepVerdict["verdict"]; evidenceNote: string } {
  if (!raw || !raw.trim()) return { verdict: "linger", evidenceNote: "(empty LLM response → default linger)" };
  try {
    const parsed = firstJsonObject(raw);
    if (!parsed) return { verdict: "linger", evidenceNote: "(no JSON in response → default linger)" };
    const verdict = parsed.verdict === "resolved" || parsed.verdict === "active" ? parsed.verdict : "linger";
    return { verdict, evidenceNote: String(parsed.evidence ?? "") };
  } catch {
    return { verdict: "linger", evidenceNote: "(JSON parse failed → default linger)" };
  }
}

const SWEEP_TAKE = numEnv("CONCERN_SWEEP_TAKE", 50);

export async function sweepConcerns(
  callLLM: SweepLLM,
  opts: { dryRun?: boolean } = {},
): Promise<SweepVerdict[]> {
  const dryRun = opts.dryRun ?? false;
  const sweepable = await prisma.memory.findMany({
    where: { experiencer: "SELF", resolution: { in: ["OPEN", "EASING"] }, isActive: true },
    orderBy: { createdAt: "desc" },
    take: SWEEP_TAKE,
  });
  if (sweepable.length === 0) return [];

  // Group by concernKey first (multiple self-scores under one concern close
  // together), fall back to topicId, then to title prefix.
  const threads = new Map<string, typeof sweepable>();
  for (const m of sweepable) {
    const key = m.concernKey ?? m.topicId ?? `__nothread_${m.title.slice(0, 15)}`;
    if (!threads.has(key)) threads.set(key, []);
    threads.get(key)!.push(m);
  }

  // Last 7 days of evidence: USER memories + events.
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const [userMemories, events] = await Promise.all([
    prisma.memory.findMany({ where: { experiencer: "USER", createdAt: { gte: weekAgo } }, take: 30 }),
    prisma.event.findMany({ where: { createdAt: { gte: weekAgo } }, orderBy: { createdAt: "desc" }, take: 80 }),
  ]);
  const evidence = [
    ...userMemories.map((m) => `MEMORY: ${m.title} - ${m.content.slice(0, 80)}`),
    ...events.map((e) => `EVENT [${e.eventType}]: ${(e.value || "").slice(0, 80)}`),
  ].join("\n");

  // Effective state: those that a real run's decay would have flipped to EASING
  // are marked EASING in the prompt too (using the same DECAY_DAYS rule). This
  // makes dryRun (which doesn't run decay first) see the same "current state" as
  // a real run, so verdicts don't drift on decay timing. In production decay has
  // already landed → resolution is already EASING; this is a no-op there.
  const staleCutoff = new Date(Date.now() - DECAY_DAYS * 86400000);
  const effRes = (m: (typeof sweepable)[number]) =>
    m.resolution === "OPEN" && (m.grounding === "EVIDENCE" || m.grounding === "SUBJECTIVE") && m.updatedAt < staleCutoff
      ? "EASING"
      : m.resolution;

  const verdicts: SweepVerdict[] = [];
  for (const [key, mems] of threads) {
    const threadDesc = mems.slice(0, 3).map((m) => `- ${m.title}: ${m.content.slice(0, 100)}`).join("\n");
    const states = [...new Set(mems.map(effRes))].join("/");
    const raw = await callLLM(
      "You are doing a self-sweep judgment. Be conservative: when unsure, linger (do nothing). Return pure JSON.",
      `Ongoing concern (current state ${states}):\n${threadDesc}\n\nRecent week of activity:\n${evidence}\n\nWhich is this concern now?\n- resolved: strong evidence it's settled → close\n- active: it's flared again / still clearly pulling → reopen to OPEN\n- linger: still fading, no strong evidence → leave alone\nReturn {"verdict": "resolved" | "active" | "linger", "evidence": "what supports it"}`,
    );

    // Failures must be visible: a failed LLM call (empty response) silently
    // treated as linger = a broken key never quietly closes. Default stays
    // linger (conservative, don't close on error), but evidence notes the
    // failure default and console.warn leaves a trace.
    if (!raw || !raw.trim()) {
      console.warn(`[self-sweep] empty LLM response for "${key}" — default linger (check LLM key / provider)`);
    }
    const { verdict, evidenceNote } = parseSweepVerdict(raw);

    let applied = false;
    if (!dryRun) {
      const ids = mems.map((m) => m.id);
      if (verdict === "resolved") {
        const r = await prisma.memory.updateMany({ where: { id: { in: ids } }, data: { resolution: "RESOLVED" } });
        applied = r.count > 0;
        console.log(`[self-sweep] resolved "${key}": ${evidenceNote}`);
      } else if (verdict === "active") {
        // reopen: EASING → OPEN (already-OPEN is a no-op)
        const r = await prisma.memory.updateMany({ where: { id: { in: ids }, resolution: "EASING" }, data: { resolution: "OPEN" } });
        applied = r.count > 0;
        console.log(`[self-sweep] reopened "${key}": ${evidenceNote}`);
      }
    }

    verdicts.push({
      key, states, verdict, evidence: evidenceNote,
      titles: mems.slice(0, 3).map((m) => m.title), memCount: mems.length, applied,
    });
  }
  return verdicts;
}

// ── positive drive (SELF_DRIVE, multi-dimension U-shape) ────────────────────
// drive = grounding × max(recency, want), one driveKey per dimension.
//   grounding = the dimension's historical backing valence average — prevents
//     neediness (no history → 0) and avoids the count confound (the average
//     doesn't depend on how many rows were written).
//   daysSinceLast = days since this dim's last event; recency = exp(-d/τ) high
//     right after; want = min(1, d/WANT) high after a long gap; max → U-shape
//     (high right after / high after a long gap / low in the middle).
//   an "owed"-style dim is want-only (the longer owed the more wanted, with no
//     "just-satisfied" high end).
// The dimension ROSTER is config-driven (DriveDef[] via loadDriveDefs / the
// DRIVE_DIMS env): each dim picks one of the four shapes below and names its own
// backing. The repo ships an EXAMPLE roster — see config.example.yaml
// selfDrive.drives and docs/DRIVES.md. Scalar tunables read from env (see
// config.example.yaml selfDrive.*).
//
// Privacy: SELF_DRIVE surfaces onto the score page / reentry, so its content is
// generalized and sourceMemoryId does not point back.
const TAU_R = numEnv("DRIVE_TAU_RECENCY", 4); // recency half-life ~2.8d
const WANT_SCALE = numEnv("DRIVE_WANT_SCALE", 14); // presence-dim want fills over 14 days
const OWED_SCALE = numEnv("DRIVE_OWED_SCALE", 21); // owed aging is slower
const GROUND_WINDOW = numEnv("DRIVE_GROUND_WINDOW", 90); // grounding history window (days)
const AFTERGLOW_V = numEnv("DRIVE_AFTERGLOW_VALENCE", 0.8); // peak self-score valence threshold
const AFTERGLOW_A = numEnv("DRIVE_AFTERGLOW_AROUSAL", 0.8); // and arousal threshold (excludes calm satisfaction)
const TAU_LIKING = numEnv("DRIVE_TAU_LIKING", 3); // afterglow=liking decay (consummatory/momentary, faster than wanting's TAU_R)
const REFRACTORY_FLOOR = numEnv("DRIVE_REFRACTORY_FLOOR", 0.07); // refractory tonic floor: a baseline craving remains even right after satisfaction (SEEKING tonic doesn't extinguish), so this dim doesn't disappear from reentry
const BOND_BETA = numEnv("DRIVE_BOND_BETA", 0.7); // bonding-satiety damping strength: after a closed bond, press the recency leg ~35%

import { DEPTH_TOPIC_SLUG } from "./depth-judge.js"; // example bonding-dim topic marker — one definition, shared with the judge

// ── drive dimensions: config-driven roster ─────────────────────────────────
// A drive dimension is YOURS to define — its name, what memories back it, and
// which of the four SEEKING shapes governs how its wanting moves. Nothing here is
// privileged: there is no built-in "intimacy" or "companionship" dim, only an
// EXAMPLE roster you rename, repoint, extend, or replace. Override the whole
// roster with the DRIVE_DIMS env (a JSON array of DriveDef); see
// config.example.yaml `selfDrive.drives` and docs/DRIVES.md (shape menu +
// "what does this companion want?" questionnaire).
//
// The four shapes (all implemented in foldDim, exercised one-per-example below):
//   symmetric  — max(recency, want)            U-shape: high right after AND after a long gap   (presence / companionship)
//   refractory — max(want·(1−recency), floor)  consummatory refractory + tonic floor            (appetite / desire; Panksepp)
//   bonding    — max(recency·(1−sat), want)    bonding satiety: a closed positive bond presses recency  (connection / deep talk)
//   owed       — want                          sensitized wanting: longer unfulfilled → more wanted     (debt-craving; Berridge)
export type DriveShape = "symmetric" | "refractory" | "bonding" | "owed";

// Which memories ground a dimension. Every field is optional — combine as needed.
export type DriveBacking = {
  memoryTypes?: string[]; // e.g. ["EPISODE"] / ["RESTRICTED"]; omit = any type
  experiencers?: ("SELF" | "SHARED" | "USER")[]; // omit = don't gate (a topic-backed dim's subject is often the other party)
  valenceFloor?: number; // keep only backing with valence >= this
  titlePrefix?: string; // keep only titles starting with this marker
  excludeWords?: string[]; // drop backing whose content contains any of these
  topicSlug?: string; // back the dim on memories tagged to this topic
  presence?: "lastChat"; // add a presence anchor (last CHAT timestamp) to the recency leg
};

export type DriveDef = { key: string; label: string; shape: DriveShape; backing: DriveBacking; wantScale?: number };

// EXAMPLE roster — illustrations, NOT your real drives. Rename them, point them at
// your own backing, add or drop dims. One per shape so every curve is exercised.
// (The labels here are deliberately generic; pick names that fit your companion —
// e.g. 陪伴 / 欲望 / 深谈 / 债务渴求.)
const DEFAULT_DRIVE_DIMS: DriveDef[] = [
  { key: "companionship", label: "companionship", shape: "symmetric", backing: { memoryTypes: ["EPISODE"], experiencers: ["SELF", "SHARED"], valenceFloor: 0.3, presence: "lastChat" }, wantScale: WANT_SCALE },
  { key: "desire", label: "desire", shape: "refractory", backing: { memoryTypes: ["RESTRICTED"], experiencers: ["SELF", "SHARED"] } },
  { key: "deep_talk", label: "deep_talk", shape: "bonding", backing: { topicSlug: DEPTH_TOPIC_SLUG } },
  { key: "owed", label: "owed", shape: "owed", backing: { topicSlug: "owed" }, wantScale: OWED_SCALE },
];

// Roster loader: DRIVE_DIMS env (JSON array of DriveDef) overrides the example.
export function loadDriveDefs(): DriveDef[] {
  try {
    const r = process.env.DRIVE_DIMS;
    if (r) {
      const parsed = JSON.parse(r);
      if (Array.isArray(parsed) && parsed.length) return parsed as DriveDef[];
    }
  } catch {
    /* malformed → fall through to the example roster */
  }
  return DEFAULT_DRIVE_DIMS;
}

// Map a shape to the foldDim options that produce its wanting curve.
export function shapeOpts(
  shape: DriveShape,
  wantScale?: number,
): { refractoryMode?: boolean; bondSatMode?: boolean; wantOnly?: boolean; wantScale?: number } {
  const base = wantScale ? { wantScale } : {};
  switch (shape) {
    case "refractory":
      return { ...base, refractoryMode: true };
    case "bonding":
      return { ...base, bondSatMode: true };
    case "owed":
      return { ...base, wantOnly: true };
    default:
      return base; // symmetric
  }
}

type DimFold = { grounding: number; daysSinceLast: number; confidence: number; n: number };

// user-feedback recalibration samples (a self-rating paired with an external
// rating). Plan A: instead of joining directly, fit a monotonic my→external
// recalibration from (self, external) pairs and apply it to all backing valence
// — corrects a systematic self-over-estimation bias.
export type ValenceSample = { self: number; user: number };

// Not enough data (< MIN) → identity; enough → a global additive offset
// (mean(external - self)), monotonic / order-preserving. Isotonic / per-axis
// refinements are deferred — first get the pipeline working and accrue data.
const RECAL_MIN_SAMPLES = numEnv("DRIVE_RECAL_MIN_SAMPLES", 5);
export function recalibrateValence(v: number, samples: ValenceSample[]): number {
  if (samples.length < RECAL_MIN_SAMPLES) return v;
  const offset = samples.reduce((s, p) => s + (p.user - p.self), 0) / samples.length;
  return Math.max(-1, Math.min(1, v + offset));
}

// Generic fold: grounding × max(recency, want). presenceAt = an extra presence
// event time (facet B uses a chat timestamp, not a memory write). wantOnly →
// want only (owed-style).
export function foldDim(
  backing: { valence: number | null; createdAt: Date; validFrom?: Date | null; bondClosure?: boolean }[],
  now: Date,
  opts: { wantOnly?: boolean; wantScale?: number; presenceAt?: Date | null; vSamples?: ValenceSample[]; refractoryMode?: boolean; bondSatMode?: boolean } = {},
): DimFold {
  // Event-date anchor: use validFrom (the true event date written by the digest
  // loop), falling back to createdAt.
  const times = backing.map((b) => (b.validFrom ?? b.createdAt).getTime());
  if (opts.presenceAt) times.push(opts.presenceAt.getTime());
  if (times.length === 0) return { grounding: 0, daysSinceLast: Infinity, confidence: 0, n: 0 };
  // valence passes through user-feedback recalibration (empty samples = identity)
  const samples = opts.vSamples ?? [];
  const vals = backing.map((b) => b.valence).filter((v): v is number => v != null).map((v) => recalibrateValence(v, samples));
  const grounding = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  const daysSinceLast = (now.getTime() - Math.max(...times)) / 86400000;
  const recency = Math.exp(-daysSinceLast / TAU_R);
  const want = Math.min(1, daysSinceLast / (opts.wantScale ?? WANT_SCALE));
  // refractoryMode (Panksepp): right after satisfaction (high recency) =
  // consummatory refractory → press want down, shouldn't want more (Fuchshuber
  // 2022). Other dims stay symmetric U (recency or want).
  // bondSatMode: if the latest backing has bondClosure (a fact) AND valence > 0,
  // apply bonding satiety pressing the recency leg (just closed a bond, less
  // urgent to reopen), but not the want leg (it returns after a few days).
  let bondSat = 0;
  if (opts.bondSatMode && backing.length) {
    // Latest backing row by event date — computed over `backing` only, NOT the
    // presence-augmented `times` (presenceAt is appended to `times`, so indexing
    // back into `backing` could land out of bounds and silently disable satiety).
    const latest = backing.reduce((a, b) =>
      ((b.validFrom ?? b.createdAt).getTime() > (a.validFrom ?? a.createdAt).getTime() ? b : a), backing[0]);
    if (latest?.bondClosure && (latest.valence ?? 0) > 0) bondSat = BOND_BETA * Math.min(1, latest.valence!);
  }
  const drive = opts.wantOnly
    ? want
    : opts.refractoryMode
      ? Math.max(want * (1 - recency), REFRACTORY_FLOOR) // tonic floor: a baseline craving remains so the dim doesn't disappear
      : opts.bondSatMode
        ? Math.max(recency * (1 - bondSat), want) // closed bond presses the recency leg; the want leg is untouched
        : Math.max(recency, want);
  return { grounding, daysSinceLast, confidence: grounding * drive, n: backing.length };
}

// Find the "owed start": the first date token (MMDD / M-D / M/D) in the text.
// state.startAt is the cleanup time and not trustworthy. An owed/debt origin is in
// the PAST, so a bare date is read as its most-recent past occurrence: parse as the
// current year; if that lands in the future, it is last year's date. (No 30-day
// window — a current-year date 5 or 40 days ahead would otherwise give a negative
// or a year-inflated age. Owed dates must be past-dated.)
function firstPromiseDate(text: string, fallback: Date, now: Date = new Date()): Date {
  for (const m of text.matchAll(/\b(\d{2})(\d{2})\b|(\d{1,2})[-/](\d{1,2})/g)) {
    const mo = m[1] ? +m[1] : +m[3];
    const day = m[1] ? +m[2] : +m[4];
    if (mo < 1 || mo > 12 || day < 1 || day > 31) continue;
    const y = now.getUTCFullYear();
    const d = new Date(Date.UTC(y, mo - 1, day));
    return d.getTime() > now.getTime() ? new Date(Date.UTC(y - 1, mo - 1, day)) : d;
  }
  return fallback;
}

type DriveDim = { key: string; label: string; fold: DimFold };

// owed = sensitized wanting (Berridge incentive sensitization: the longer
// unfulfilled, the more wanted) — a wanting scalar sourced from explicit
// commitment debt (a RELATIONSHIP state containing a debt/owed marker).
//
// STATUS: exported as a ready INPUT to the wanting−liking gap, but NO consumer
// ships in core — the damping signal that reads this scalar (vs the liking scalar
// below) is application-specific and intentionally not bundled. Here as a worked
// example + a wired-ready input, not an active feature. Don't trace a consumer.
export async function computeOwedWanting(now: Date = new Date()): Promise<number> {
  const debtStates = await prisma.activeState.findMany({
    where: { stateType: "RELATIONSHIP", isActive: true },
    select: { title: true, content: true, startAt: true },
  });
  const debt = debtStates.find((s) => /\bowed?\b|debt/i.test(s.title) || /\bowed?\b|debt/i.test(s.content ?? ""));
  if (!debt) return 0;
  const origin = firstPromiseDate(`${debt.title} ${debt.content ?? ""}`, debt.startAt, now);
  const days = (now.getTime() - origin.getTime()) / 86400000;
  return Math.min(1, days / OWED_SCALE);
}

// Compute each dim's fold + thought boost without writing the DB — shared by the
// real projection (deriveDrives) and the observer (self-digest view), so the
// observer sees the same grounding/recency/want breakdown that lands in the DB
// confidence, to the digit.
// afterglow = Berridge liking (consummatory hedonic, doesn't drive behavior) →
// excluded from drive ranking. Computes a liking scalar (recency-weighted
// intensity of the most recent peak) for the wanting−liking gap.
//
// STATUS: same as computeOwedWanting — a ready INPUT to the gap, no core
// consumer. Exported as a worked example, not a wired feature.
export async function computeAfterglowLiking(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - GROUND_WINDOW * 86400000);
  const afterglow = await prisma.memory.findMany({
    where: { memoryType: "SELF_SCORE", isActive: true, experiencer: "SELF", valence: { gte: AFTERGLOW_V }, arousal: { gte: AFTERGLOW_A }, createdAt: { gte: cutoff, lte: now } },
    select: { valence: true, createdAt: true, validFrom: true },
  });
  let liking = 0;
  for (const m of afterglow) {
    const days = (now.getTime() - (m.validFrom ?? m.createdAt).getTime()) / 86400000;
    const v = (m.valence ?? 0) * Math.exp(-days / TAU_LIKING);
    if (v > liking) liking = v;
  }
  return liking;
}

// A backing row, in the shape foldDim consumes.
type BackingRow = { title: string; content: string; valence: number | null; createdAt: Date; validFrom: Date | null; bondClosure: boolean };

// Resolve a DriveBacking spec into the memories that ground a dimension. This is
// the single place that turns a (declarative) backing into a query — so a forker
// defines a dim entirely in config, no engine edit. Returns [] for a topicSlug
// that doesn't exist yet (a not-yet-used dim simply doesn't stand up).
async function loadDriveBacking(backing: DriveBacking, groundCutoff: Date, now: Date): Promise<BackingRow[]> {
  const where: any = { isActive: true, createdAt: { gte: groundCutoff, lte: now } };
  if (backing.memoryTypes?.length) where.memoryType = { in: backing.memoryTypes };
  if (backing.experiencers?.length) where.experiencer = { in: backing.experiencers };
  if (typeof backing.valenceFloor === "number") where.valence = { gte: backing.valenceFloor };
  if (backing.topicSlug) {
    const t = await prisma.topic.findUnique({ where: { slug: backing.topicSlug } });
    if (!t) return [];
    where.topicId = t.id;
  }
  let rows = await prisma.memory.findMany({
    where,
    select: { title: true, content: true, valence: true, createdAt: true, validFrom: true, bondClosure: true },
  });
  if (backing.titlePrefix) rows = rows.filter((r) => r.title.startsWith(backing.titlePrefix!));
  if (backing.excludeWords?.length) rows = rows.filter((r) => !backing.excludeWords!.some((w) => r.content.includes(w)));
  return rows;
}

export async function previewDriveDims(now: Date = new Date()): Promise<{ dims: DriveDim[]; boostByDim: Map<string, number> }> {
  const groundCutoff = new Date(now.getTime() - GROUND_WINDOW * 86400000);
  const defs = loadDriveDefs();

  // presence anchor — the last real user message on the chat surfaces. Only the
  // timestamp is read as a presence signal; content is not. Real message sources
  // only, NOT a broad eventType:"CHAT" query: system arc records (closeout etc.)
  // are SYSTEM events and must never count as the user being present — this source
  // filter is belt-and-suspenders against any other non-message CHAT source.
  const needsPresence = defs.some((d) => d.backing.presence === "lastChat");
  const lastChat = needsPresence
    ? await prisma.event.findFirst({
        where: {
          eventType: "CHAT",
          source: { in: [CHAT_SOURCE, CROSS_CHAT_SOURCE] },
          createdAt: { lte: now },
        },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      })
    : null;

  // user-feedback samples (plan A): (self, external) pairs from SCORE_FEEDBACK
  // events, calibrating the self-rated valence.
  const fbEvents = await prisma.event.findMany({ where: { eventType: "SCORE_FEEDBACK" }, select: { value: true } });
  const vSamples: ValenceSample[] = [];
  for (const e of fbEvents) {
    try {
      const p = JSON.parse(e.value ?? "{}");
      const self = p?.selfSnapshot?.valence;
      const user = p?.userValence;
      if (typeof self === "number" && typeof user === "number") vSamples.push({ self, user });
    } catch {
      /* skip bad json */
    }
  }

  // afterglow has left drive ranking (Berridge: afterglow = liking, doesn't drive
  // behavior). computeAfterglowLiking() / computeOwedWanting() turn it into the
  // wanting−liking gap scalars instead (Panksepp plan P1/P2) — those are separate
  // from this roster (note: the example `owed` DIM below is a want-only drive
  // row, distinct from the computeOwedWanting gap scalar).
  const dims: { key: string; label: string; fold: DimFold }[] = [];
  for (const def of defs) {
    const backing = await loadDriveBacking(def.backing, groundCutoff, now);
    const presenceAt = def.backing.presence === "lastChat" ? (lastChat?.createdAt ?? null) : null;
    const fold = foldDim(backing, now, { ...shapeOpts(def.shape, def.wantScale), presenceAt, vSamples });
    dims.push({ key: def.key, label: def.label, fold });
  }

  // thought-pool drive_boost — a fixation thought feeds back into its matching
  // dim (THOUGHT_HIT.value = "dim:key"). It only lifts dims that already have
  // grounding>0 (the continue below still gates on grounding); empty Map = no
  // change.
  const boostByDim = await driveBoostByDim(now);
  return { dims, boostByDim };
}

export async function deriveDrives(opts: { dryRun?: boolean; now?: Date } = {}): Promise<DeriveResult> {
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? new Date();
  const { dims, boostByDim } = await previewDriveDims(now);

  const existing = await prisma.activeState.findMany({ where: { stateType: "SELF_DRIVE", source: "derive", isActive: true } });
  const byKey = new Map(existing.filter((s) => s.sourceKey).map((s) => [s.sourceKey!, s]));
  let upserted = 0, deactivated = 0;
  const liveKeys = new Set<string>();

  for (const d of dims) {
    const f = d.fold;
    const boost = boostByDim.get(d.key) ?? 0;
    if (f.grounding <= 0 || f.confidence + boost <= 0.01) continue; // no real grounding → don't stand up (a thought doesn't conjure a dim)
    liveKeys.add(d.key);
    const conf = Math.round(Math.min(1, f.confidence + boost) * 100) / 100;
    const data = {
      title: `drive · ${d.label}`,
      summary: `${d.key} ${conf} · grounding ${f.grounding.toFixed(2)} · last ${Math.round(f.daysSinceLast)}d`,
      content: `${d.label} drive ${conf}. grounding ${f.grounding.toFixed(2)} (this dim's real positive), last event ${Math.round(f.daysSinceLast)} days ago. U-shape: high right after or after a long gap, low in the middle.`,
      confidence: conf,
      sourceMemoryId: null as string | null, // no back-pointer (privacy)
      isActive: true,
      endAt: null as Date | null,
    };
    if (dryRun) { upserted++; continue; }
    const ex = byKey.get(d.key);
    if (ex) await prisma.activeState.update({ where: { id: ex.id }, data });
    else await prisma.activeState.create({ data: { stateType: "SELF_DRIVE", source: "derive", sourceKey: d.key, startAt: now, ...data } });
    upserted++;
  }
  // deactivate dims that lost backing (including any old single-dim key)
  for (const s of existing) {
    if (s.sourceKey && liveKeys.has(s.sourceKey)) continue;
    if (!dryRun) await prisma.activeState.update({ where: { id: s.id }, data: { isActive: false, endAt: now } });
    deactivated++;
  }
  return { upserted, deactivated, keys: [...liveKeys] };
}

// Time decay: an OPEN EVIDENCE/SUBJECTIVE concern not updated for DECAY_DAYS →
// EASING (felt strength fades, attention no longer pulled). DATA does not decay
// (the probe manages it). SUBJECTIVE never auto-RESOLVES.
const DECAY_DAYS = numEnv("CONCERN_DECAY_DAYS", 10);
export async function decayStaleConcerns(opts: { dryRun?: boolean } = {}): Promise<number> {
  const cutoff = new Date(Date.now() - DECAY_DAYS * 86400000);
  const stale = await prisma.memory.findMany({
    where: {
      experiencer: "SELF",
      resolution: "OPEN",
      isActive: true,
      grounding: { in: ["EVIDENCE", "SUBJECTIVE"] },
      updatedAt: { lt: cutoff },
    },
    select: { id: true },
  });
  if (!opts.dryRun && stale.length) {
    await prisma.memory.updateMany({
      where: { id: { in: stale.map((m) => m.id) } },
      data: { resolution: "EASING" },
    });
  }
  return stale.length;
}
