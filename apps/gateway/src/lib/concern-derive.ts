// self-concern engine — derive() is the sole writer that projects
// Memory(SELF concern) into ActiveState SELF_CONCERN. Idempotent, can be rebuilt
// from Memory at any time → drift self-heals.
//
// It only owns the rows it created (source="derive"). Legacy hand-set rows
// (source!=derive) are left alone.

import prisma from "../db.js";
import { driveBoostByDim } from "./thought-pool.js";

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
const SS_NEG_VALENCE = Number(process.env.CONCERN_SS_NEG_VALENCE ?? -0.2); // threshold for self-score "negative"
const SS_STRONG_NEG = Number(process.env.CONCERN_SS_STRONG_NEG ?? -0.6); // strong negative: rare hard signal, stands up same-day (bypasses the gate)
const SS_MIN_COUNT = Number(process.env.CONCERN_SS_MIN_COUNT ?? 2); // weak negatives need at least N under the same key
const SS_MIN_DAYS = Number(process.env.CONCERN_SS_MIN_DAYS ?? 2); // across at least N distinct calendar days
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
      if (negs.length === 0) continue;
      const days = new Set(negs.map((m) => (m.validFrom ?? m.createdAt).toISOString().slice(0, 10)));
      // strong single (v <= SS_STRONG_NEG) stands up immediately; weak negatives
      // need >= SS_MIN_COUNT across >= SS_MIN_DAYS days
      const strongSingle = negs.some((m) => (m.valence ?? 0) <= SS_STRONG_NEG);
      if (!strongSingle && (negs.length < SS_MIN_COUNT || days.size < SS_MIN_DAYS)) continue; // recurrence not met → don't surface (memory stays OPEN as evidence)
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

const SWEEP_TAKE = Number(process.env.CONCERN_SWEEP_TAKE ?? 50);

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
    let verdict: SweepVerdict["verdict"] = "linger";
    let evidenceNote = "";
    if (!raw || !raw.trim()) {
      evidenceNote = "(empty LLM response → default linger)";
      console.warn(`[self-sweep] empty LLM response for "${key}" — default linger (check LLM key / provider)`);
    } else {
      try {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          if (parsed.verdict === "resolved" || parsed.verdict === "active") verdict = parsed.verdict;
          evidenceNote = String(parsed.evidence ?? "");
        } else {
          evidenceNote = "(no JSON in response → default linger)";
        }
      } catch {
        evidenceNote = "(JSON parse failed → default linger)";
      }
    }

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
// Dimension labels are neutral placeholders (dimA/dimB/dimC) driven by config —
// the upstream application supplies its own semantic labels. The facet-A word
// filter and facet-C signal word list default empty (config-driven). Tunables
// read from env (see config.example.yaml selfDrive.*).
//
// Privacy: SELF_DRIVE surfaces onto the score page / reentry, so its content is
// generalized and sourceMemoryId does not point back.
const TAU_R = Number(process.env.DRIVE_TAU_RECENCY ?? 4); // recency half-life ~2.8d
const WANT_SCALE = Number(process.env.DRIVE_WANT_SCALE ?? 14); // presence-dim want fills over 14 days
const OWED_SCALE = Number(process.env.DRIVE_OWED_SCALE ?? 21); // owed aging is slower
const GROUND_WINDOW = Number(process.env.DRIVE_GROUND_WINDOW ?? 90); // grounding history window (days)
const AFTERGLOW_V = Number(process.env.DRIVE_AFTERGLOW_VALENCE ?? 0.8); // peak self-score valence threshold
const AFTERGLOW_A = Number(process.env.DRIVE_AFTERGLOW_AROUSAL ?? 0.8); // and arousal threshold (excludes calm satisfaction)
const TAU_LIKING = Number(process.env.DRIVE_TAU_LIKING ?? 3); // afterglow=liking decay (consummatory/momentary, faster than wanting's TAU_R)
const REFRACTORY_FLOOR = Number(process.env.DRIVE_REFRACTORY_FLOOR ?? 0.07); // refractory tonic floor: a baseline craving remains even right after satisfaction (SEEKING tonic doesn't extinguish), so this dim doesn't disappear from reentry
const BOND_BETA = Number(process.env.DRIVE_BOND_BETA ?? 0.7); // bonding-satiety damping strength: after a closed bond, press the recency leg ~35%

// Word lists default empty (config-driven). The facet-A exclusion list filters
// out matching backing; the facet-C signal list is a legacy fallback (the main
// path uses the topic marker below). Both are empty by default — the upstream
// application supplies its own vocabulary or leaves them empty.
const FACET_A_EXCLUDE_WORDS: string[] = (() => {
  try { const r = process.env.DRIVE_FACETA_EXCLUDE_WORDS; if (r) return JSON.parse(r); } catch { /* default */ }
  return [];
})();
const DEPTH_TOPIC_SLUG = process.env.DEPTH_TOPIC_SLUG ?? "depth-topic"; // facet-C unified topic marker across write paths

// Neutral dimension labels (dimA/dimB/dimC). Override via config to inject
// private semantic labels.
function dimLabels(): { dimA: string; dimB: string; dimC: string } {
  try {
    const r = process.env.DRIVE_DIM_LABELS;
    if (r) return { dimA: "dimA", dimB: "dimB", dimC: "dimC", ...JSON.parse(r) };
  } catch {
    /* default */
  }
  return { dimA: "dimA", dimB: "dimB", dimC: "dimC" };
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
const RECAL_MIN_SAMPLES = Number(process.env.DRIVE_RECAL_MIN_SAMPLES ?? 5);
export function recalibrateValence(v: number, samples: ValenceSample[]): number {
  if (samples.length < RECAL_MIN_SAMPLES) return v;
  const offset = samples.reduce((s, p) => s + (p.user - p.self), 0) / samples.length;
  return Math.max(-1, Math.min(1, v + offset));
}

// Generic fold: grounding × max(recency, want). presenceAt = an extra presence
// event time (facet B uses a chat timestamp, not a memory write). wantOnly →
// want only (owed-style).
function foldDim(
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
  if (opts.bondSatMode && times.length) {
    const latest = backing[times.indexOf(Math.max(...times))];
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

// Find the "owed start": the first valid date (in appearance order, usually at
// the start of the content). Supports MMDD / M-D / M/D. state.startAt is the
// cleanup time and not trustworthy. The year is inferred from now: parse as the
// current year first; if that lands more than 30 days in the future it's
// actually last year's date, so roll back a year.
function firstPromiseDate(text: string, fallback: Date, now: Date = new Date()): Date {
  for (const m of text.matchAll(/\b(\d{2})(\d{2})\b|(\d{1,2})[-/](\d{1,2})/g)) {
    const mo = m[1] ? +m[1] : +m[3];
    const day = m[1] ? +m[2] : +m[4];
    if (mo < 1 || mo > 12 || day < 1 || day > 31) continue;
    const y = now.getUTCFullYear();
    const d = new Date(Date.UTC(y, mo - 1, day));
    return d.getTime() > now.getTime() + 30 * 86400000 ? new Date(Date.UTC(y - 1, mo - 1, day)) : d;
  }
  return fallback;
}

type DriveDim = { key: string; label: string; fold: DimFold };

// owed = sensitized wanting (Berridge incentive sensitization: the longer
// unfulfilled, the more wanted). Panksepp plan P2: no longer a standalone drive
// dim (natural craving already lives in each facet's want leg); instead computes
// a wanting scalar for the wanting−liking gap — sourced from explicit commitment
// debt (a RELATIONSHIP state containing a debt/owed marker).
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

// Unified depth marker across write paths: read the depth topic id. The drive
// deriver's facet-C backing reads it (any memory mapped to this topic counts),
// not a word list. The topic is ensured by the write path / backfill.
export async function getDepthTopicId(): Promise<string | null> {
  const t = await prisma.topic.findUnique({ where: { slug: DEPTH_TOPIC_SLUG } });
  return t?.id ?? null;
}

// Compute each dim's fold + thought boost without writing the DB — shared by the
// real projection (deriveDrives) and the observer (self-digest view), so the
// observer sees the same grounding/recency/want breakdown that lands in the DB
// confidence, to the digit.
// afterglow = Berridge liking (consummatory hedonic, doesn't drive behavior) →
// excluded from drive ranking (Panksepp plan P1). Instead computes a liking
// scalar (recency-weighted intensity of the most recent peak) for the
// wanting−liking gap.
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

export async function previewDriveDims(now: Date = new Date()): Promise<{ dims: DriveDim[]; boostByDim: Map<string, number> }> {
  const groundCutoff = new Date(now.getTime() - GROUND_WINDOW * 86400000);
  const labels = dimLabels();

  // facet A backing pool, with the word filter excluding matching entries.
  const restrictedMems = await prisma.memory.findMany({
    where: { memoryType: "RESTRICTED", isActive: true, experiencer: { in: ["SELF", "SHARED"] }, createdAt: { gte: groundCutoff, lte: now } },
    select: { id: true, title: true, valence: true, arousal: true, createdAt: true, validFrom: true, content: true },
  });
  const filtered = FACET_A_EXCLUDE_WORDS.length
    ? restrictedMems.filter((s) => !FACET_A_EXCLUDE_WORDS.some((w) => s.content.includes(w)))
    : restrictedMems;
  // facet A vs facet B split by a title prefix marker, set by the backfill (the
  // backfill classification is ground truth). Entries prefixed "[A " go to facet
  // A; the rest fall through to facet B.
  const facetA = filtered.filter((s) => s.title.startsWith("[A "));
  const facetAIds = new Set(facetA.map((s) => s.id));
  const facetBRestricted = filtered.filter((s) => !facetAIds.has(s.id));

  // facet B episode pool (facet C is split out, see below)
  const episodes = await prisma.memory.findMany({
    where: { memoryType: "EPISODE", isActive: true, experiencer: { in: ["SELF", "SHARED"] }, valence: { gte: 0.3 }, createdAt: { gte: groundCutoff, lte: now } },
    select: { id: true, topicId: true, valence: true, createdAt: true, validFrom: true, content: true },
  });
  // facet C backing: cross-write-path unified — read the depth topic's memories
  // (any memoryType/model mapped to it), rather than an EPISODE + word-list
  // filter. The write path tags the topic (main path) + backfill (fallback).
  const depthTopicId = await getDepthTopicId();
  const depth = depthTopicId
    ? await prisma.memory.findMany({
        // facet C does NOT gate on experiencer (unlike facet A/B). facet A/B are
        // the self's / shared experiences, so they gate SELF/SHARED; facet C
        // backing has a subject that is often the other party, so its
        // experiencer is often USER. The topic marker is ground truth.
        where: { topicId: depthTopicId, isActive: true, createdAt: { gte: groundCutoff, lte: now } },
        select: { id: true, valence: true, createdAt: true, validFrom: true, content: true, bondClosure: true },
      })
    : [];
  // facet B episodes exclude any already mapped to the depth topic (when no
  // topic exists = all episodes).
  const facetBEpisodes = depthTopicId ? episodes.filter((e) => e.topicId !== depthTopicId) : episodes;

  // afterglow has left drive ranking (Berridge: afterglow = liking, doesn't
  // drive behavior). Its backing is instead turned into a liking scalar above by
  // computeAfterglowLiking(), feeding the wanting−liking gap (Panksepp plan P1).

  // facet B presence anchor — the last chat event (any surface). Only the
  // timestamp is read as a presence signal; content is not read.
  const lastChat = await prisma.event.findFirst({
    where: { eventType: "CHAT", createdAt: { lte: now } },
    orderBy: { createdAt: "desc" }, select: { createdAt: true },
  });

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

  const dims: { key: string; label: string; fold: DimFold }[] = [
    { key: "dimA", label: labels.dimA, fold: foldDim(facetA, now, { vSamples, refractoryMode: true }) },
    { key: "dimB", label: labels.dimB, fold: foldDim([...facetBEpisodes, ...facetBRestricted], now, { presenceAt: lastChat?.createdAt ?? null, vSamples }) },
    { key: "dimC", label: labels.dimC, fold: foldDim(depth, now, { vSamples, bondSatMode: true }) },
  ];

  // owed dim removed (Panksepp plan P2): natural craving lives in each facet's
  // want leg; explicit commitment debt is computed into a wanting scalar by
  // computeOwedWanting() instead of being a standalone drive dim.

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
const DECAY_DAYS = Number(process.env.CONCERN_DECAY_DAYS ?? 10);
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
