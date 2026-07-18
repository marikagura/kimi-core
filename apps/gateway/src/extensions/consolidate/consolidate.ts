// Consolidate window — an opt-in weekly curation pass. The engine only computes
// CANDIDATES; every write decision stays with the human (the event-sourcing +
// manual-curation line is deliberate — see docs/CURATION.md). Once a week it runs
// three passes and writes a single review list as a SYSTEM event
// (source=consolidate) — the next session reads the list via event_read/reentry,
// looks at the material, and decides what (if anything) to link or write. Zero
// obligation on the reader.
//
// The pass order (triage → digest/debt → cluster) and its "miss rather than
// mis-file" thresholds follow the scheduling lesson published in
// zziying/consolidation-draft (https://github.com/zziying/consolidation-draft):
// running the passes in reverse starves the clusters. That repo ships no license,
// so this is an expression-isolated acknowledgment — no code or prose is copied,
// only the scheduling idea is credited (see docs/CURATION.md).
//
// FLAT DEMO: the routine-prefix / arc-prefix filters below ship as neutral English
// placeholders. A deployment points them at its own title conventions via the
// CONSOLIDATE_* env vars; nothing here encodes any private vocabulary.
//
// Two ways to run it:
//   - manual:     npm run consolidate
//   - scheduled:  enable the extension (KIMI_EXTENSIONS=consolidate) and set
//                 CONSOLIDATE_CRON (e.g. "0 23 * * 0" — Sunday 23:00) — the daemon
//                 then runs runConsolidate on that cron.

import "dotenv/config";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import prisma from "../../db.js";
import { numEnv } from "../../lib/env.js";
import { isoWeekKey } from "../weekly-arc/weekly-arc.js";

// ── config: in-code defaults + env overrides ─────────────────────────────────
// A JSON string[] env override, mirroring numEnv's fail-loud contract: fall back
// (with a warning) on unset / invalid JSON / non-string[], never silently corrupt.
function jsonStrArrEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
    console.warn(`[env] ${name} is not a JSON string[] — using default`);
  } catch {
    console.warn(`[env] ${name} is not valid JSON — using default`);
  }
  return fallback;
}

// Routine title prefixes: the "summary-fragment noise" layer — routine memories
// (diaries, weekly arcs, self-scores, chat/session digests, excursions) that
// should not enter triage or clustering (the manual-link door stays open anyway).
// English placeholders; override with your own via CONSOLIDATE_ROUTINE_PREFIXES.
const ROUTINE_PREFIXES = jsonStrArrEnv("CONSOLIDATE_ROUTINE_PREFIXES", [
  "diary ",
  "weekly arc",
  "weekly review",
  "self-score ",
  "[chat",
  "[intimate",
  "excursion ",
]);

// Arc title prefixes: memories that ARE a topic's narrative summary (an "arc"
// anchored under a topic). dirtyTopics flags a topic whose newest arc lags the
// links added after it. The shipped core writes a weekly arc that is NOT
// topic-anchored, so with no topic-anchored-arc convention this pass stays inert
// (mechanism present, no material) until a deployment adopts one and points this
// at its arc titles via CONSOLIDATE_ARC_PREFIXES.
const ARC_PREFIXES = jsonStrArrEnv("CONSOLIDATE_ARC_PREFIXES", ["arc ", "weekly arc"]);

const POOL_MIN_IMPORTANCE = numEnv("CONSOLIDATE_POOL_MIN_IMPORTANCE", 3);
const TRIAGE_COS = numEnv("CONSOLIDATE_TRIAGE_COS", 0.7); // pass 1: attach-suggestion threshold
const CLUSTER_EDGE = numEnv("CONSOLIDATE_CLUSTER_EDGE", 0.6); // pass 3: connected-component edge
const CLUSTER_MIN = numEnv("CONSOLIDATE_CLUSTER_MIN", 3); // min members to be a cluster
const CLUSTER_MAX = numEnv("CONSOLIDATE_CLUSTER_MAX", 8); // max members shown per cluster
const DIRTY_NEWER = numEnv("CONSOLIDATE_DIRTY_NEWER", 2); // pass 2: min new links to flag a topic
const DIRTY_OLDEST_DAYS = numEnv("CONSOLIDATE_DIRTY_OLDEST_DAYS", 7); // or oldest debt older than this
const TRIAGE_TAKE = numEnv("CONSOLIDATE_TRIAGE_TAKE", 20); // cap on triage lines in the list
const CLUSTER_TAKE = numEnv("CONSOLIDATE_CLUSTER_TAKE", 3); // cap on clusters in the list

// ── pool filter: unattached (topicId null), importance>=floor, embedded,
// non-routine memories. Prisma.sql keeps the config-driven prefixes parametrized
// (no string interpolation → no injection surface from an env-supplied value). ──
function poolWhere(): Prisma.Sql {
  const routinePatterns = ROUTINE_PREFIXES.map((p) => `${p}%`);
  return Prisma.sql`
    m."isActive" = true
    AND m."topicId" IS NULL
    AND m.importance >= ${POOL_MIN_IMPORTANCE}
    AND m.embedding IS NOT NULL
    AND m."memoryType" NOT IN ('SELF_SCORE', 'RESTRICTED')
    AND NOT (m.title LIKE ANY(${routinePatterns}::text[]))`;
}

type PoolRow = { id: string; title: string; importance: number; emb: number[] };

function parseVec(s: string): number[] {
  return s.slice(1, -1).split(",").map(Number);
}

function cos(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

async function loadPool(): Promise<PoolRow[]> {
  const rows: { id: string; title: string; importance: number; emb: string }[] =
    await prisma.$queryRaw`
      SELECT m.id, m.title, m.importance, m.embedding::text AS emb
      FROM memories m WHERE ${poolWhere()}`;
  return rows.map((r) => ({ id: r.id, title: r.title, importance: r.importance, emb: parseVec(r.emb) }));
}

// ── pass 1: triage — unattached memory vs active-topic centroid ──────────────
// Topic centroids are the mean of each topic's attached embeddings, computed on
// the fly (does not depend on whether topic.embedding was ever backfilled).
export async function triage(pool: PoolRow[]): Promise<string[]> {
  const centroids: { slug: string; emb: string }[] = await prisma.$queryRaw`
    SELECT t.slug, avg(m.embedding)::text AS emb
    FROM topics t JOIN memories m ON m."topicId" = t.id
    WHERE t.status = 'ACTIVE' AND m."isActive" = true AND m.embedding IS NOT NULL
    GROUP BY t.slug HAVING count(*) >= 2`;
  const cents = centroids.map((c) => ({ slug: c.slug, emb: parseVec(c.emb) }));
  const out: string[] = [];
  for (const p of pool) {
    let best: { slug: string; c: number } | null = null;
    for (const c of cents) {
      const s = cos(p.emb, c.emb);
      if (s >= TRIAGE_COS && (!best || s > best.c)) best = { slug: c.slug, c: s };
    }
    if (best) out.push(`cos=${best.c.toFixed(2)} → ${best.slug} ← ${p.title}`);
  }
  return out.sort().reverse().slice(0, TRIAGE_TAKE);
}

// ── pass 2: debt roll-call — a topic's arc summary lags the links added after ──
// dirty = links entered the topic after the arc's updatedAt; flag only when the
// new-link count reaches DIRTY_NEWER or the oldest debt is older than
// DIRTY_OLDEST_DAYS (a small debt accrues quietly — nagging every night scares
// people off; the threshold is part of the same scheduling lesson).
export async function dirtyTopics(): Promise<string[]> {
  const arcPatterns = ARC_PREFIXES.map((p) => `${p}%`);
  const rows: { slug: string; newer: bigint; oldest: Date }[] = await prisma.$queryRaw`
    SELECT t.slug, count(m.id) AS newer, min(m."createdAt") AS oldest
    FROM memories v
    JOIN topics t ON v."topicId" = t.id
    JOIN memories m ON m."topicId" = t.id AND m.id <> v.id
      AND m."isActive" = true AND m."createdAt" > v."updatedAt"
    WHERE (v.title LIKE ANY(${arcPatterns}::text[])) AND v."isActive" = true
    GROUP BY t.slug, v."updatedAt"`;
  const now = Date.now();
  return rows
    .filter((r) => Number(r.newer) >= DIRTY_NEWER || now - r.oldest.getTime() > DIRTY_OLDEST_DAYS * 86400_000)
    .map((r) => `${r.slug}: ${r.newer} new links since the arc, oldest ${r.oldest.toISOString().slice(0, 10)}`);
}

// ── pass 3: cluster candidates — new lines in the unattached pool ─────────────
// Pool is a few hundred rows; no Leiden needed — connected components over the
// cos>=CLUSTER_EDGE graph + importance ordering is enough. Whether a cluster is
// really one thing is NOT decided here — the list goes to a session and a human
// judges; the machine does not adjudicate.
export function clusterCandidates(pool: PoolRow[]): string[] {
  const n = pool.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) if (cos(pool[i].emb, pool[j].emb) >= CLUSTER_EDGE) parent[find(i)] = find(j);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  }
  const clusters = [...groups.values()]
    .filter((g) => g.length >= CLUSTER_MIN)
    .map((g) => g.sort((a, b) => pool[b].importance - pool[a].importance).slice(0, CLUSTER_MAX))
    .sort((a, b) => b.reduce((s, i) => s + pool[i].importance, 0) - a.reduce((s, i) => s + pool[i].importance, 0))
    .slice(0, CLUSTER_TAKE);
  return clusters.map((g, k) => `cluster ${k + 1} (${g.length}): ${g.map((i) => pool[i].title).join(" | ")}`);
}

// ── roll-up → SYSTEM event (deduped per ISO week) ────────────────────────────
export async function runConsolidate(): Promise<{ weekKey: string; written: boolean }> {
  const weekKey = isoWeekKey(new Date());
  const dedupeKey = `consolidate:${weekKey}`;
  const existing = await prisma.event.findFirst({ where: { dedupeKey } });
  if (existing) {
    console.log(`[consolidate] ${weekKey} list already exists, skipping`);
    return { weekKey, written: false };
  }

  const pool = await loadPool();
  const [tri, dirty] = [await triage(pool), await dirtyTopics()];
  const clusters = clusterCandidates(pool);

  const sections: string[] = [];
  if (tri.length) sections.push(`[triage suggestions ${tri.length}]\n${tri.join("\n")}`);
  if (dirty.length) sections.push(`[debt roll-call ${dirty.length}]\n${dirty.join("\n")}`);
  if (clusters.length) sections.push(`[new-line candidates ${clusters.length}]\n${clusters.join("\n")}`);

  console.log(
    `[consolidate] ${weekKey}: pool=${pool.length} triage=${tri.length} debt=${dirty.length} clusters=${clusters.length}`,
  );
  if (!sections.length) return { weekKey, written: false };

  const value = `review list ${weekKey} (pool=${pool.length})\n\n${sections.join("\n\n")}`.slice(0, 6000);
  await prisma.event.create({
    data: { eventType: "SYSTEM", value, source: "consolidate", dedupeKey },
  });
  return { weekKey, written: true };
}

// CLI entry — only when run directly (not when imported by the extension).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runConsolidate()
    .then((r) => {
      console.log(`[consolidate] done ${r.weekKey} written=${r.written}`);
      process.exit(0);
    })
    .catch((e: unknown) => {
      console.error("[consolidate] failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
