// ============================================================================
// Retrieval core — single source of truth for memory_search scoring.
//
// `scoreMemories(query, opts)` runs the hybrid retrieval pipeline:
//   embed → SQL CTE (entity_hits + per-row sem/kw/time/entity signals)
//         → JS final weighting → filter → sort → slice.
//
// This is the DRY scorer: both the `memory_search` MCP tool and the eval
// harness call this, so there is exactly ONE copy of the SQL string + weights
// + filter. No hand-copied drift.
//
// The numeric knobs (four-arm weights, SEM_FLOOR, the final floors, the kw
// filter floor, the time-decay rate, the ILIKE rung scores, the rerank pool
// size, the BM25 saturation K) are surfaced as named consts with env overrides
// so a deployment can retune them via config without forking this file.
// ============================================================================

import { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { embedText, toVectorLiteral } from "./embed.js";
import { rerankCandidates } from "./reranker.js";

export type MemoryType =
  | "CORE"
  | "STATE"
  | "EPISODE"
  | "PREFERENCE"
  | "BOUNDARY"
  | "RESTRICTED";

// Component toggles. sem/kw are live: turning one off drops its weighted
// contribution from `final` (the SQL still computes the raw signal, but it is
// zeroed before weighting so it does not influence ranking/filter).
// rerank: default false → golden path unchanged; true → cross-encoder re-ranks
// the top-N hybrid survivors (graceful no-op when no rerank key/provider is
// configured). bm25: lexical CJK n-gram arm, default OFF.
export type Components = {
  sem?: boolean;
  kw?: boolean;
  bm25?: boolean;
  rerank?: boolean;
};

// scope: which fact stores the hybrid scorer reaches.
//   'default' — memories table only, RESTRICTED excluded (the live/golden path).
//               Public, non-audit surfaces use this.
//   'full'    — for the general search path (no type/topic filter), also folds
//               in observations + core_profile (incl. sensitive rows) and stops
//               excluding RESTRICTED memories, so a single retrieval reaches every
//               recallable fact. The private audit/eval scope. Public-surface
//               exposure is gated at the surface filter layer, NOT here.
export type ScoreOpts = {
  limit?: number;
  memoryType?: MemoryType;
  topicId?: string;
  components?: Components;
  scope?: "default" | "full";
};

// A scored memory row. Carries the full memory columns selected by the SQL
// (id/title/content/summary/importance/… plus sem_sim/kw_sim/time_decay/
// via_entity/entity_names) spread in, alongside the JS-derived fields
// (sem/kw/t/final/entities/scoreBreakdown).
export type ScoredMemory = {
  id: string;
  title: string;
  content: string;
  summary: string | null;
  importance: number | null;
  memoryType: string;
  via_entity: boolean;
  entity_names: string[] | null;
  sem: number;
  kw: number;
  t: number;
  final: number;
  entities: string[];
  scoreBreakdown: {
    semantic: { raw: number; weight: number; contribution: number };
    keyword: { raw: number; weight: number; contribution: number };
    time: { raw: number; weight: number; contribution: number };
    importance: { raw: number; weight: number; contribution: number };
    entityHit: boolean;
    entities: string[];
    final: number;
  };
  [key: string]: any;
};

// ----------------------------------------------------------------------------
// Tunable scoring knobs. Defaults are inlined; each can be overridden via the
// matching env var (or wired to a config layer) without changing this file.
// ----------------------------------------------------------------------------

// Four-arm hybrid weights (semantic / keyword / time-decay / importance).
const W_SEM = parseFloat(process.env.RETRIEVAL_W_SEM || "") || 0.35;
const W_KW = parseFloat(process.env.RETRIEVAL_W_KW || "") || 0.5;
const W_TIME = parseFloat(process.env.RETRIEVAL_W_TIME || "") || 0.1;
const W_IMP = parseFloat(process.env.RETRIEVAL_W_IMP || "") || 0.05;

// Pure-semantic floor: a hit with NO kw/entity signal must clear this raw
// cosine to be kept. Keyword/entity hits bypass it (reliable). Sits in the gap
// between unrelated-query cosine and true-relevant pure-semantic cosine, so it
// blocks false positives while keeping real semantic recall.
const SEM_FLOOR = parseFloat(process.env.RETRIEVAL_SEM_FLOOR || "") || 0.38;

// Pure-semantic `final` gate. Default scope keeps the stricter cutoff. Folded
// obs/profile docs (scope='full') carry no summary leg / entity edges, so a
// legit pure-semantic hit lands lower on `final`; full scope relaxes the gate.
// Negatives still can't enter — the sem>=SEM_FLOOR condition is unchanged.
const SEM_FINAL_FLOOR_DEFAULT = parseFloat(process.env.RETRIEVAL_SEM_FINAL_FLOOR || "") || 0.2;
const SEM_FINAL_FLOOR_FULL = parseFloat(process.env.RETRIEVAL_SEM_FINAL_FLOOR_FULL || "") || 0.15;

// kw filter floor: a survivor with kw >= this is kept regardless of sem. Drops
// nonsense queries against very-recent rows (whose time-decay boost would
// otherwise sneak them in). Strong kw / entity matches bypass the sem cap.
const KW_FILTER_FLOOR = parseFloat(process.env.RETRIEVAL_KW_FILTER_FLOOR || "") || 0.3;

// Recency time-decay rate (per day) used in the SQL EXP(-rate * age_days).
const TIME_DECAY_RATE = parseFloat(process.env.RETRIEVAL_TIME_DECAY_RATE || "") || 0.1;

// ILIKE rung scores for the kw GREATEST() ladder (title > summary > content),
// plus the entity-hit kw bonus.
const ILIKE_TITLE = parseFloat(process.env.RETRIEVAL_ILIKE_TITLE || "") || 0.9;
const ILIKE_SUMMARY = parseFloat(process.env.RETRIEVAL_ILIKE_SUMMARY || "") || 0.8;
const ILIKE_CONTENT = parseFloat(process.env.RETRIEVAL_ILIKE_CONTENT || "") || 0.7;
const ENTITY_KW_BONUS = parseFloat(process.env.RETRIEVAL_ENTITY_KW_BONUS || "") || 0.95;

// Rerank candidate pool size: wider than `limit` so the reranker can pull a
// good doc up from a deeper rank that the hybrid sort buried.
const RERANK_POOL_DEFAULT = parseInt(process.env.RERANK_POOL || "", 10) || 30;

// BM25 (PGroonga) saturation constant: raw pgroonga_score is unbounded;
// pg_score/(pg_score+K) saturates it into (0,1).
const PG_BM25_K = parseFloat(process.env.PG_BM25_K || "") || 3;

// Diagnostic: max sem over ALL memories for the last scored query (pre-filter),
// surfaced by eval verbose to tune SEM_FLOOR against real neg/pos spread.
let lastMaxSem = 0;
export function getLastMaxSem(): number {
  return lastMaxSem;
}

// ----------------------------------------------------------------------------
// Pure scoring core — extracted from scoreMemories so the four-arm weighting and
// the false-positive filter (the gate the whole engine leans on) can be unit-
// tested WITHOUT a database. scoreMemories maps/filters every row through these;
// behavior is byte-identical to the previous inline version.
// ----------------------------------------------------------------------------

// One raw SQL row → weighted `final` + per-signal breakdown. Component toggles
// (useSem/useKw default ON) zero a signal's contribution so it drops out of
// `final` and the downstream filter.
export function scoreRow(m: any, opts: { useSem?: boolean; useKw?: boolean } = {}): ScoredMemory {
  const useSem = opts.useSem ?? true;
  const useKw = opts.useKw ?? true;
  const semRaw = Number(m.sem_sim) || 0;
  const kwRaw = Number(m.kw_sim) || 0;
  const sem = useSem ? semRaw : 0;
  const kw = useKw ? kwRaw : 0;
  const t = Number(m.time_decay) || 0;
  const imp = (Number(m.importance) || 3) / 5;
  const final = sem * W_SEM + kw * W_KW + t * W_TIME + imp * W_IMP;
  const entities: string[] = m.entity_names ?? [];
  const scoreBreakdown = {
    semantic: { raw: sem, weight: W_SEM, contribution: sem * W_SEM },
    keyword: { raw: kw, weight: W_KW, contribution: kw * W_KW },
    time: { raw: t, weight: W_TIME, contribution: t * W_TIME },
    importance: { raw: imp, weight: W_IMP, contribution: imp * W_IMP },
    entityHit: !!m.via_entity,
    entities,
    final,
  };
  return { ...m, sem, kw, t, final, entities, scoreBreakdown };
}

// Survivor filter: keep a hit iff it has a real kw signal (>= KW floor) OR an
// entity edge OR a pure-semantic hit clearing BOTH the final gate and the raw-
// cosine floor. This blocks the false positives cosine alone would return in a
// 1536-d space. Strong kw / entity bypass the sem cap.
export function passesFilter(
  m: { kw: number; via_entity?: boolean; final: number; sem: number },
  semFinalFloor: number = SEM_FINAL_FLOOR_DEFAULT,
): boolean {
  return m.kw >= KW_FILTER_FLOOR || !!m.via_entity || (m.final >= semFinalFloor && m.sem >= SEM_FLOOR);
}

export async function scoreMemories(
  query: string,
  opts: ScoreOpts = {},
): Promise<ScoredMemory[]> {
  const { limit = 10, memoryType, topicId, components, scope = "default" } = opts;
  // Live components default ON (preserves original behavior when omitted).
  // bm25/rerank default OFF.
  const useSem = components?.sem ?? true;
  const useKw = components?.kw ?? true;
  // Rerank stays OFF unless explicitly requested. When false (the default and
  // the only path the live tool / golden eval take) every line below the
  // `scored` chain is skipped — the function returns the same sorted, sliced
  // array as the no-rerank path. This is the golden invariant.
  const useRerank = components?.rerank === true;
  // BM25 (PGroonga) lexical arm. Default OFF → every pgroonga SQL fragment
  // below is Prisma.empty, so the generated SQL is the original. ON → adds a
  // CJK n-gram TF signal folded INTO the kw GREATEST (augments pg_trgm, doesn't
  // replace it) across memories + (full scope) obs/profile.
  const useBm25 = components?.bm25 === true;

  const typeFilter = memoryType
    ? Prisma.sql`AND m."memoryType"::text = ${memoryType}`
    : scope === "full"
      ? Prisma.empty // full audit scope: include RESTRICTED memories too
      : Prisma.sql`AND m."memoryType"::text <> 'RESTRICTED'`;
  const topicFilter = topicId
    ? Prisma.sql`AND m."topicId" = ${topicId}`
    : Prisma.empty;

  // Semantic vector (cosine sim) — null if no API key / no body / embed
  // returns null; falls through with sem_sim=0 so keyword paths still win.
  const emb = await embedText(query);
  const vecLit = emb ? toVectorLiteral(emb) : null;

  // Entity-mention edges: query may name an entity directly (alias, English
  // handle, even an emoji) — surface every memory linked to a matching ACTIVE
  // entity. ILIKE on entity.name string also catches aliases since aliases are
  // encoded inline in the name.
  const qPattern = `%${query}%`;

  // One scoring pass over every active memory. pg sorts after. At current row
  // counts this is fine; past ~10k rows switch to a candidate-pool CTE (HNSW +
  // trgm GIN) before scoring.
  const semExpr = vecLit
    ? Prisma.sql`(1.0 - (m.embedding <=> ${vecLit}::vector))`
    : Prisma.sql`0.0`;

  // PGroonga arm for the memories query. OFF → all three are Prisma.empty.
  const pgMemCte = useBm25
    ? Prisma.sql`, pg_hits AS (
      SELECT m.id AS memory_id, pgroonga_score(m.tableoid, m.ctid) AS pg_score
      FROM memories m
      WHERE (m.title &@~ ${query} OR m.summary &@~ ${query} OR m.content &@~ ${query})
        AND m."isActive" = true
    )`
    : Prisma.empty;
  const pgMemJoin = useBm25 ? Prisma.sql`LEFT JOIN pg_hits ph ON ph.memory_id = m.id` : Prisma.empty;
  const pgMemArm = useBm25
    ? Prisma.sql`, COALESCE(ph.pg_score / (ph.pg_score + ${PG_BM25_K}::float8), 0)`
    : Prisma.empty;

  const rows: any[] = await prisma.$queryRaw`
    WITH entity_hits AS (
      SELECT l."toId" AS memory_id, array_agg(DISTINCT e.name) AS entity_names
      FROM links l
      JOIN entities e ON e.id = l."fromId" AND e.status = 'ACTIVE'
      WHERE l."fromType" = 'entity'
        AND l."toType" = 'memory'
        AND l."relationType" = 'mentions'
        AND e.name ILIKE ${qPattern}
      GROUP BY l."toId"
    )${pgMemCte}
    SELECT m.id, m.title, m.content, m.summary, m.importance,
           m.valence, m.arousal, m.experiencer, m.resolution,
           m."topicId", m."memoryType", m."activationCount",
           CASE WHEN m.embedding IS NOT NULL THEN ${semExpr} ELSE 0 END AS sem_sim,
           GREATEST(
             CASE WHEN coalesce(m.title,   '') ILIKE ${qPattern} THEN ${ILIKE_TITLE} ELSE 0 END,
             CASE WHEN coalesce(m.summary, '') ILIKE ${qPattern} THEN ${ILIKE_SUMMARY} ELSE 0 END,
             CASE WHEN coalesce(m.content, '') ILIKE ${qPattern} THEN ${ILIKE_CONTENT} ELSE 0 END,
             similarity(coalesce(m.title,   ''), ${query}),
             similarity(coalesce(m.summary, ''), ${query}),
             similarity(coalesce(m.content, ''), ${query}),
             CASE WHEN eh.memory_id IS NOT NULL THEN ${ENTITY_KW_BONUS} ELSE 0 END
             ${pgMemArm}
           ) AS kw_sim,
           EXP(-${TIME_DECAY_RATE} * EXTRACT(EPOCH FROM (NOW() - m."createdAt")) / 86400.0) AS time_decay,
           (eh.memory_id IS NOT NULL) AS via_entity,
           eh.entity_names AS entity_names
    FROM memories m
    LEFT JOIN entity_hits eh ON eh.memory_id = m.id
    ${pgMemJoin}
    WHERE m."isActive" = true
      ${typeFilter}
      ${topicFilter}
  `;

  // R-pool augmentation: in 'full' scope on the general search path, fold the
  // non-memory fact stores (observations + core_profile) into the SAME row set
  // so they go through the identical map/filter/sort below. Each projected row
  // carries the columns the scorer reads (sem_sim/kw_sim/time_decay/importance/
  // via_entity/entity_names) plus passthrough fields; missing concepts
  // (summary/valence/entity edges) are NULL/false. Typed/topic searches never
  // reach here, so they stay memory-only and unchanged.
  if (scope === "full" && !memoryType && !topicId) {
    const obsSem = vecLit
      ? Prisma.sql`CASE WHEN o.embedding IS NOT NULL THEN (1.0 - (o.embedding <=> ${vecLit}::vector)) ELSE 0 END`
      : Prisma.sql`0.0`;
    // PGroonga arm for observations. OFF → all Prisma.empty (unchanged).
    const pgObsCte = useBm25
      ? Prisma.sql`WITH pg_obs AS (
        SELECT o.id AS oid, pgroonga_score(o.tableoid, o.ctid) AS pg_score
        FROM observations o
        WHERE (o.title &@~ ${query} OR o.content &@~ ${query}) AND o."isActive" = true
      ) `
      : Prisma.empty;
    const pgObsJoin = useBm25 ? Prisma.sql`LEFT JOIN pg_obs po ON po.oid = o.id` : Prisma.empty;
    const pgObsArm = useBm25
      ? Prisma.sql`, COALESCE(po.pg_score / (po.pg_score + ${PG_BM25_K}::float8), 0)`
      : Prisma.empty;
    const obsRows: any[] = await prisma.$queryRaw`
      ${pgObsCte}SELECT o.id, o.title, o.content,
             NULL::text AS summary, o.importance,
             NULL::double precision AS valence, NULL::double precision AS arousal,
             CASE WHEN o.subject = 'self' THEN 'SELF' ELSE 'USER' END AS experiencer,
             NULL::text AS resolution, NULL::text AS "topicId",
             'OBSERVATION' AS "memoryType", 0 AS "activationCount",
             ${obsSem} AS sem_sim,
             GREATEST(
               CASE WHEN coalesce(o.title,   '') ILIKE ${qPattern} THEN ${ILIKE_TITLE} ELSE 0 END,
               CASE WHEN coalesce(o.content, '') ILIKE ${qPattern} THEN ${ILIKE_CONTENT} ELSE 0 END,
               similarity(coalesce(o.title,   ''), ${query}),
               similarity(coalesce(o.content, ''), ${query})
               ${pgObsArm}
             ) AS kw_sim,
             1.0 AS time_decay, -- observations are a trait/observation layer, not time-sensitive: excluded from recency decay
             false AS via_entity, NULL::text[] AS entity_names
      FROM observations o
      ${pgObsJoin}
      WHERE o."isActive" = true
    `;
    const profSem = vecLit
      ? Prisma.sql`CASE WHEN c.embedding IS NOT NULL THEN (1.0 - (c.embedding <=> ${vecLit}::vector)) ELSE 0 END`
      : Prisma.sql`0.0`;
    // PGroonga arm for core_profile. OFF → all Prisma.empty (unchanged).
    const pgProfCte = useBm25
      ? Prisma.sql`WITH pg_prof AS (
        SELECT c.id AS cid, pgroonga_score(c.tableoid, c.ctid) AS pg_score
        FROM core_profile c
        WHERE (c.title &@~ ${query} OR c.content &@~ ${query}) AND c."isActive" = true
      ) `
      : Prisma.empty;
    const pgProfJoin = useBm25 ? Prisma.sql`LEFT JOIN pg_prof pp ON pp.cid = c.id` : Prisma.empty;
    const pgProfArm = useBm25
      ? Prisma.sql`, COALESCE(pp.pg_score / (pp.pg_score + ${PG_BM25_K}::float8), 0)`
      : Prisma.empty;
    const profRows: any[] = await prisma.$queryRaw`
      ${pgProfCte}SELECT c.id, c.title, c.content,
             NULL::text AS summary, c.importance,
             NULL::double precision AS valence, NULL::double precision AS arousal,
             'USER' AS experiencer,
             NULL::text AS resolution, NULL::text AS "topicId",
             'PROFILE' AS "memoryType", 0 AS "activationCount",
             ${profSem} AS sem_sim,
             GREATEST(
               CASE WHEN coalesce(c.title,   '') ILIKE ${qPattern} THEN ${ILIKE_TITLE} ELSE 0 END,
               CASE WHEN coalesce(c.content, '') ILIKE ${qPattern} THEN ${ILIKE_CONTENT} ELSE 0 END,
               similarity(coalesce(c.title,   ''), ${query}),
               similarity(coalesce(c.content, ''), ${query})
               ${pgProfArm}
             ) AS kw_sim,
             1.0 AS time_decay, -- core_profile is a stable fact layer, not time-sensitive: excluded from recency decay
             false AS via_entity, NULL::text[] AS entity_names
      FROM core_profile c
      ${pgProfJoin}
      WHERE c."isActive" = true
    `;
    rows.push(...obsRows, ...profRows);
  }

  const SEM_FINAL_FLOOR = scope === "full" ? SEM_FINAL_FLOOR_FULL : SEM_FINAL_FLOOR_DEFAULT;

  // Diagnostic max sem over the full pre-filter row set. Uses the raw sem_sim
  // from SQL so the value is the same regardless of the component toggle (the
  // toggle only zeros the *weighted* contribution, not this diagnostic).
  lastMaxSem = rows.reduce((mx, m) => Math.max(mx, Number(m.sem_sim) || 0), 0);

  // Survivors of hybrid scoring + filter, sorted by `final` (high→low). The
  // `.slice(0, limit)` is deferred below so the rerank branch can take a wider
  // candidate pool from the same sorted array. Splitting a (mutating) `.sort()`
  // from a (pure) `.slice()` is behavior-identical.
  // Score every row (pure scoreRow) → keep survivors (pure passesFilter) →
  // sort by `final` high→low. .slice(0, limit) is deferred so the rerank branch
  // can take a wider pool from the same sorted array.
  // NOTE: rerank deliberately does NOT touch passesFilter — it runs on raw
  // cosine/kw/entity signals (a different scale), so it only RE-ORDERS survivors.
  const sortedSurvivors = rows
    .map((m: any) => scoreRow(m, { useSem, useKw }))
    .filter((m) => passesFilter(m, SEM_FINAL_FLOOR))
    .sort((a, b) => b.final - a.final);

  // GOLDEN PATH: rerank off → identical to a chained `.sort(...).slice(0,
  // limit)`. No reranker import is exercised, no env read, no behavior change.
  if (!useRerank) {
    return sortedSurvivors.slice(0, limit) as ScoredMemory[];
  }

  // Privacy guard: the full-scope candidate pool can contain RESTRICTED / sensitive
  // text. A `local` provider never leaves the machine and is safe; but if
  // RERANK_PROVIDER is a third-party API (cohere/jina/voyage), rerank would
  // ship that text off-box. full scope + non-local → refuse rerank, fall back
  // to hybrid order.
  if (scope === "full" && (process.env.RERANK_PROVIDER || "none").trim().toLowerCase() !== "local") {
    return sortedSurvivors.slice(0, limit) as ScoredMemory[];
  }

  // RERANK PATH (opt-in). Take a wider candidate pool from the top of the
  // hybrid-sorted survivors, ask the cross-encoder to score them, then re-sort
  // that pool by a rerank-substituted `final` and slice to `limit`. Pool size
  // (default 30, env RERANK_POOL): wider than limit so the reranker can pull a
  // good doc up from a deeper rank that hybrid sort buried.
  const RERANK_POOL = Math.max(limit, RERANK_POOL_DEFAULT);
  const pool = sortedSurvivors.slice(0, RERANK_POOL);
  // Doc text per candidate: title + (summary || content[:500]) — the same
  // surface the memory_search tool renders, so the reranker judges what the
  // user actually sees.
  const docs = pool.map((m) => {
    const body = (m.summary && m.summary.length > 0)
      ? m.summary
      : String(m.content ?? "").slice(0, 500);
    return body ? `${m.title}\n${body}` : String(m.title ?? "");
  });

  const rerankScores = await rerankCandidates(query, docs);

  // Graceful degrade: no key / provider unset / HTTP failure → null. Fall back
  // to the hybrid order, which is exactly the rerank=off result. So a keyless
  // deploy with rerank=true is still byte-identical to rerank=off.
  if (rerankScores === null) {
    return sortedSurvivors.slice(0, limit) as ScoredMemory[];
  }

  // Substitute the rerank score into the `sem` slot and recompute `final`,
  // keeping the kw/time/importance mix intact (don't wash out personal/lexical
  // signal). scoreBreakdown.semantic.raw becomes the rerank score, and a
  // `rerank` flag + the original cosine are recorded for explainability.
  const reranked = pool.map((m, i) => {
    const rerankScore = rerankScores[i] ?? 0;
    const cosine = Number(m.sem_sim) || 0; // raw cosine, pre-substitution
    const kw = m.kw as number;
    const t = m.t as number;
    const imp = (Number(m.importance) || 3) / 5;
    const final = rerankScore * W_SEM + kw * W_KW + t * W_TIME + imp * W_IMP;
    const scoreBreakdown = {
      ...m.scoreBreakdown,
      semantic: {
        raw: rerankScore,
        weight: W_SEM,
        contribution: rerankScore * W_SEM,
        rerank: true,
        cosine,
      },
      final,
    };
    return { ...m, sem: rerankScore, final, scoreBreakdown };
  });

  reranked.sort((a, b) => b.final - a.final);
  return reranked.slice(0, limit) as ScoredMemory[];
}
