// ============================================================================
// Shared KG traversal — walkGraph.
//
// One BFS over the `links` table that both the background loop and the
// graph_walk MCP tool call. Replaces an inlined link-walk that hardcoded
// confidence>=0.7 + memory<->memory only.
//
// Edge classes currently in `links`:
//   memory->memory   similar
//   entity->memory   mentions
//   topic->memory    tagged
//   entity<->entity   co_mentioned    (undirected, stored once with fromId<toId)
//
// IMPORTANT: links.fromId/toId are bare text; node ids (memory/entity/topic/
// observation) are uuids. JOINs cast id::text. Indexes:
//   [fromType, fromId, relationType]  and  [toType, toId]
// ============================================================================

import prisma from "../db.js";

export interface WalkOpts {
  /** Starting node ids. */
  startIds: string[];
  /** Type of the starting nodes ('memory' | 'entity' | 'topic' | 'observation'). */
  startType: string;
  /** Number of hops to expand. Default 1, hard-capped at 3. */
  hops?: number;
  /** If set, only traverse edges with this relationType. */
  relationType?: string;
  /** Minimum link confidence. Default 0.55 — most `similar` edges sit below 0.7
   *  in practice. Can be overridden per call / via config. */
  minConfidence?: number;
  /** Max edges expanded per hop per direction. Default 10. */
  perHopLimit?: number;
  /** Traverse both from->to and to->from. Default true (required to walk the
   *  undirected co_mentioned edges from either end). */
  undirected?: boolean;
}

export interface WalkNode {
  /** Node id (uuid as text). */
  id: string;
  /** Node type ('memory' | 'entity' | 'topic' | 'observation'). */
  type: string;
  /** Human-readable label (memory/observation->title, entity/topic->name). */
  label: string;
  /** relationType of the edge this node was reached through. */
  relationType: string;
  /** confidence of that edge. */
  confidence: number;
  /** Hop depth at which this node was first reached (1-based). */
  hop: number;
}

const HOP_CAP = 3;

/** Map a node type to its table + label column. */
const NODE_TABLE: Record<string, { table: string; labelCol: string }> = {
  memory: { table: "memories", labelCol: "title" },
  entity: { table: "entities", labelCol: "name" },
  topic: { table: "topics", labelCol: "name" },
  observation: { table: "observations", labelCol: "title" },
};

/**
 * Breadth-first walk over the KG `links` table.
 *
 * - frontier loop runs `hops` times (capped at 3).
 * - `visited` Set (seeded with the start ids) dedups across hops and breaks
 *   cycles — a node is never expanded or emitted twice.
 * - each hop queries forward edges (fromId in frontier AND fromType = curType)
 *   and, when undirected, the reverse edges (toId in frontier AND toType =
 *   curType), each LIMIT perHopLimit. confidence >= minConfidence always; an
 *   optional relationType filter narrows further.
 * - the next frontier is the *new* nodes found this hop. Their type can differ
 *   from the previous hop's (entity->memory via mentions, then memory->memory via
 *   similar), so we group the frontier by type and query each group.
 * - hit nodes get their label resolved by type (id::text match against the
 *   right table). A total node cap (perHopLimit*hops*2) guards against blowup.
 */
export async function walkGraph(opts: WalkOpts): Promise<WalkNode[]> {
  const hops = Math.min(Math.max(1, opts.hops ?? 1), HOP_CAP);
  const minConfidence = opts.minConfidence ?? 0.55;
  const perHopLimit = opts.perHopLimit ?? 10;
  const undirected = opts.undirected ?? true;
  const relationType = opts.relationType;

  const startIds = (opts.startIds ?? []).map(String).filter(Boolean);
  if (startIds.length === 0) return [];

  const totalCap = perHopLimit * hops * 2;

  // visited: node ids already emitted or queued (seeded with start ids so we
  // never walk back onto our own origin). Keyed by id alone — a uuid is unique
  // across node types, and links never point an id at two different types.
  const visited = new Set<string>(startIds);
  const results: WalkNode[] = [];

  // current frontier, grouped by node type. (type -> ids)
  let frontier = new Map<string, string[]>([[opts.startType, [...startIds]]]);

  for (let hop = 1; hop <= hops; hop++) {
    if (frontier.size === 0) break;

    // Raw edges found this hop: { neighborId, neighborType, relationType, confidence }
    const edges: Array<{
      id: string;
      type: string;
      relationType: string;
      confidence: number;
    }> = [];

    for (const [curType, ids] of frontier) {
      if (ids.length === 0) continue;

      // Forward: frontier nodes are the `from` side.
      const fwd: any[] = relationType
        ? await prisma.$queryRaw`
            SELECT "toId" AS nid, "toType" AS ntype, "relationType" AS rel, confidence
            FROM links
            WHERE "fromId" = ANY(${ids}::text[])
              AND "fromType" = ${curType}
              AND confidence >= ${minConfidence}
              AND "relationType" = ${relationType}
            ORDER BY confidence DESC
            LIMIT ${perHopLimit}
          `
        : await prisma.$queryRaw`
            SELECT "toId" AS nid, "toType" AS ntype, "relationType" AS rel, confidence
            FROM links
            WHERE "fromId" = ANY(${ids}::text[])
              AND "fromType" = ${curType}
              AND confidence >= ${minConfidence}
            ORDER BY confidence DESC
            LIMIT ${perHopLimit}
          `;
      for (const r of fwd) {
        edges.push({
          id: String(r.nid),
          type: String(r.ntype),
          relationType: String(r.rel),
          confidence: Number(r.confidence),
        });
      }

      // Reverse: frontier nodes are the `to` side. Needed to walk the
      // undirected co_mentioned edges (stored once, fromId<toId) from either
      // end, and to follow any directed edge backwards.
      if (undirected) {
        const rev: any[] = relationType
          ? await prisma.$queryRaw`
              SELECT "fromId" AS nid, "fromType" AS ntype, "relationType" AS rel, confidence
              FROM links
              WHERE "toId" = ANY(${ids}::text[])
                AND "toType" = ${curType}
                AND confidence >= ${minConfidence}
                AND "relationType" = ${relationType}
              ORDER BY confidence DESC
              LIMIT ${perHopLimit}
            `
          : await prisma.$queryRaw`
              SELECT "fromId" AS nid, "fromType" AS ntype, "relationType" AS rel, confidence
              FROM links
              WHERE "toId" = ANY(${ids}::text[])
                AND "toType" = ${curType}
                AND confidence >= ${minConfidence}
              ORDER BY confidence DESC
              LIMIT ${perHopLimit}
            `;
        for (const r of rev) {
          edges.push({
            id: String(r.nid),
            type: String(r.ntype),
            relationType: String(r.rel),
            confidence: Number(r.confidence),
          });
        }
      }
    }

    // Dedup new neighbors against visited; keep the first (best-LIMIT-ordered)
    // edge per new node. Build the next frontier from these.
    const nextFrontier = new Map<string, string[]>();
    const newThisHop: Array<(typeof edges)[number]> = [];
    for (const e of edges) {
      if (visited.has(e.id)) continue;
      if (results.length + newThisHop.length >= totalCap) break;
      visited.add(e.id);
      newThisHop.push(e);
      if (!nextFrontier.has(e.type)) nextFrontier.set(e.type, []);
      nextFrontier.get(e.type)!.push(e.id);
    }

    // Resolve labels for the new nodes, grouped by type (one query per type).
    for (const [type, ids] of nextFrontier) {
      const meta = NODE_TABLE[type];
      const labels = new Map<string, string>();
      if (meta) {
        // table/column names can't be parameterized — build via Prisma.raw
        // around a parameterized id list. type is a fixed key from NODE_TABLE
        // (never user text), so no injection surface.
        const rows: any[] = await prisma.$queryRawUnsafe(
          `SELECT id::text AS id, "${meta.labelCol}" AS label FROM ${meta.table} WHERE id::text = ANY($1::text[])`,
          ids,
        );
        for (const r of rows) labels.set(String(r.id), String(r.label ?? ""));
      }
      for (const e of newThisHop) {
        if (e.type !== type) continue;
        results.push({
          id: e.id,
          type: e.type,
          label: labels.get(e.id) ?? "",
          relationType: e.relationType,
          confidence: e.confidence,
          hop,
        });
      }
    }

    if (results.length >= totalCap) break;
    frontier = nextFrontier;
  }

  return results;
}
