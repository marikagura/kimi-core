// ============================================================================
// Shared MCP tool registry.
// Both the stdio server (index.ts) and the SSE server (http-server.ts) register
// the same tools through registerAllTools(server).
//
// If you add, remove, or change a tool, do it here — nowhere else.
//
// Open-source core: this registry exposes the memory engine only — memory,
// topics, state, entities, observations, events, profiles, register presets,
// and the context builders (reentry / reentry_delta / closeout). Surface
// integrations (mail, calendar, location/weather, finance, etc.) are not part
// of the core and are wired separately by a deployment.
// ============================================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import prisma from "./db.js";
import { jst, jstDate, localDate } from "./time.js";
import { embedText, toVectorLiteral } from "./lib/embed.js";
import { scoreMemories } from "./lib/retrieval.js";
import { sweepMemoryMentions } from "./lib/entity-mentions.js";
import { walkGraph } from "./lib/graph-walk.js";
import { deriveConcerns, deriveDrives, slugify } from "./lib/concern-derive.js";
import { tagDepthIfNeeded } from "./lib/depth-judge.js";
import {
  isColdStartExcluded,
  publicSearchDrop,
} from "./lib/reentry-filter.js";

// ----------------------------------------------------------------------------
// Tool registration
// ----------------------------------------------------------------------------

export function registerAllTools(server: McpServer) {
  // ==========================================================================
  // Memory
  // ==========================================================================

  server.tool(
    "memory_write",
    "Write a new memory to the database. Supports emotional coordinates (valence/arousal) and experiencer tagging (USER/SELF/SHARED).",
    {
      title: z.string().describe("Memory title"),
      content: z.string().describe("Memory content"),
      summary: z.string().describe("Summary, <=300 chars. (1) do not repeat title (2) cover the full arc — cause / course / conclusion (3) keep the most important concrete details (numbers / names / key quoted phrases) (4) note any unresolved carryover."),
      memoryType: z
        .enum(["CORE", "STATE", "EPISODE", "PREFERENCE", "BOUNDARY", "RESTRICTED", "SELF_SCORE"])
        .default("EPISODE")
        .describe("Type of memory. SELF_SCORE = a session self-assessment (valence + arousal + one line). If negative valence and it exposes a recurring, still-uncorrected behavioral failure: also pass resolution=OPEN + grounding=EVIDENCE + concernKey=stable bare slug (reuse the same slug across sessions so relapses aggregate); after recurring across days it surfaces as a SELF_CONCERN."),
      importance: z.number().min(1).max(5).default(3).describe("Importance level 1-5"),
      sourceType: z
        .enum(["CHAT", "WEB", "REPO", "EVENT", "MANUAL"])
        .default("CHAT")
        .describe("Source of this memory"),
      topicSlug: z.string().optional().describe("Topic slug to link this memory to (resolved server-side)"),
      topicId: z.string().optional().describe("Topic id (use either topicSlug or topicId; topicId wins if both)"),
      valence: z.number().min(-1).max(1).optional().describe("-1 to 1"),
      arousal: z.number().min(0).max(1).optional().describe("0 to 1"),
      experiencer: z.enum(["USER", "SELF", "SHARED"]).optional(),
      resolution: z.enum(["OPEN", "EASING", "SUPPRESSED", "RESOLVED"]).optional(),
      grounding: z
        .enum(["DATA", "EVIDENCE", "SUBJECTIVE"])
        .optional()
        .describe("self-concern v2: grounding tier of this SELF concern (selects the resolver). Leave empty for non-concern memories."),
      concernKey: z
        .string()
        .optional()
        .describe("self-concern v2: stable thread slug (one concern shares one slug across days). Only when set does derive project it into a displayed state."),
      validFrom: z
        .string()
        .optional()
        .describe("Event date ISO (used by the digest loop: the day the conversation/session actually happened, not the write time). Unset = write time. Score placement / drive recency / concern startAt all anchor on it."),
      authorModel: z
        .string()
        .optional()
        .describe("Instrument attribution: the caller's own model id. SELF-type memories (SELF_SCORE / diary / experiencer=SELF) must pass it so the score view can tell which instrument logged the score."),
    },
    async ({
      title,
      content,
      summary,
      memoryType,
      importance,
      sourceType,
      topicSlug,
      topicId,
      valence,
      arousal,
      experiencer,
      resolution,
      grounding,
      concernKey,
      validFrom,
      authorModel,
    }) => {
      // authorModel guard: SELF-type memories (SELF_SCORE / experiencer=SELF)
      // must be attributed, otherwise the score view can't tell which
      // instrument logged the score. Reject so the caller can supply it.
      if ((memoryType === "SELF_SCORE" || experiencer === "SELF") && !authorModel) {
        return {
          content: [
            {
              type: "text" as const,
              text: "authorModel required: SELF-type memories (SELF_SCORE / experiencer=SELF) must attribute the caller's model id. Retry with authorModel.",
            },
          ],
          isError: true,
        };
      }
      console.log("[memory_write] entry", {
        title_len: title?.length,
        content_type: typeof content,
        content_len: typeof content === "string" ? content.length : -1,
        content_head: typeof content === "string" ? content.slice(0, 40) : null,
        has_markdown: typeof content === "string" && /[*`#]/.test(content),
      });
      let resolvedTopicId: string | undefined = topicId;
      if (!resolvedTopicId && topicSlug) {
        const topic = await prisma.topic.findUnique({ where: { slug: topicSlug } });
        if (topic) resolvedTopicId = topic.id;
      }

      // self-score strong-negative auto-concern: a v <= -0.6 self-assessment is
      // a hard signal. Even if the writer didn't tag it, give it key + OPEN +
      // EVIDENCE here so it surfaces as a SELF_CONCERN (the "strong single-day
      // bypass" lives in deriveConcerns).
      let ssRes: typeof resolution = resolution ?? "RESOLVED";
      let ssGrounding = grounding;
      let ssKey = concernKey;
      if (memoryType === "SELF_SCORE" && typeof valence === "number" && valence <= -0.6 && !ssKey) {
        const day = localDate(validFrom ? new Date(validFrom) : new Date());
        ssKey = `badsession_${day}`;
        ssGrounding = ssGrounding ?? "EVIDENCE";
        ssRes = "OPEN";
      }
      // Prisma's default return includes all columns; embedding is
      // Unsupported("vector(1536)") which cannot be deserialized. Use `select`
      // to avoid pulling it back.
      const memory = await prisma.memory.create({
        data: {
          title,
          content,
          summary,
          memoryType,
          importance,
          sourceType,
          topicId: resolvedTopicId,
          valence,
          arousal,
          experiencer: experiencer ?? "USER",
          // Default RESOLVED — a real SELF_CONCERN must explicitly pass "OPEN".
          // SELF_CONCERN is a narrow pool; diary / self-score default to done.
          // (SELF_SCORE v<=-0.6 fallback above sets ssRes/ssGrounding/ssKey.)
          resolution: ssRes,
          // self-concern v2: grounding tier + stable thread key (concerns only).
          grounding: ssGrounding,
          concernKey: ssKey,
          // Event-date anchor — the digest loop passes the day a session
          // actually happened; unset → Prisma default now().
          ...(validFrom ? { validFrom: new Date(validFrom) } : {}),
          // Instrument attribution: which model wrote this.
          authorModel,
        },
        select: { id: true, title: true },
      });

      // Dual-write embedding. Prisma schema declares embedding as
      // Unsupported("vector(1536)") which can't be set via create({ data }),
      // so we UPDATE with raw SQL. Failure is tolerated — the nightly sweep
      // patches any null rows next run.
      const embText = `${title}\n${summary || content}`;
      const emb = await embedText(embText);
      if (emb) {
        const vec = toVectorLiteral(emb);
        // Write embeddingAt too — the sweep uses it to decide whether an edited
        // row's embedding is stale; without it the first updatedAt bump would
        // trigger one redundant re-embed.
        await prisma.$executeRaw`
          UPDATE memories SET embedding = ${vec}::vector, "embeddingAt" = NOW() WHERE id = ${memory.id}
        `;
      }

      // Depth fallback: qualifying memories with no topic get an async depth
      // judgment so an untagged depth memory still gets tagged. Fire-and-forget.
      void tagDepthIfNeeded({ id: memory.id, title, content, memoryType, importance, topicId: resolvedTopicId ?? null });

      // Entity-mention sweep. Scans active entities (+ aliases) against this
      // memory's text and writes any new (entity → memory) edges in `links`.
      // Failure swallowed — a backfill job catches up later.
      try {
        await sweepMemoryMentions(memory.id);
      } catch (e: any) {
        console.warn("[memory_write] mention sweep failed:", e?.message ?? e);
      }

      // Breadcrumb so an ambient loop can detect what a session just recorded.
      // Raw chat isn't in the event table; memory writes are the content
      // channel. RESTRICTED records type only, not title (title may be sensitive).
      // Failure swallowed — pure observability.
      try {
        const crumb =
          memoryType === "RESTRICTED"
            ? { memoryType, importance, experiencer: experiencer ?? "USER" }
            : { title: memory.title, memoryType, importance, experiencer: experiencer ?? "USER" };
        await prisma.event.create({
          data: {
            eventType: "SYSTEM",
            source: "memory_write",
            value: JSON.stringify(crumb),
          },
        });
      } catch (e: any) {
        console.warn("[memory_write] breadcrumb event failed:", e?.message ?? e);
      }

      return { content: [{ type: "text", text: `Memory saved: ${memory.id} — "${memory.title}"` }] };
    },
  );

  server.tool(
    "memory_reopen",
    "Reopen a RESOLVED/SUPPRESSED memory back to OPEN — for a SELF_CONCERN that selfSweep mis-resolved or that returned to active attention. Appends a [reopened] note to content.",
    {
      id: z.string().describe("Memory id to reopen"),
      reason: z.string().describe("Why this needs reopening — short, becomes part of content"),
    },
    async ({ id, reason }) => {
      const existing = await prisma.memory.findUnique({
        where: { id },
        select: { id: true, title: true, resolution: true, content: true },
      });
      if (!existing) {
        return { content: [{ type: "text", text: `Memory ${id} not found.` }] };
      }
      if (existing.resolution === "OPEN") {
        return { content: [{ type: "text", text: `Memory "${existing.title}" already OPEN — nothing to do.` }] };
      }
      const today = localDate(new Date());
      const newContent = `${existing.content}\n\n[reopened ${today}: ${reason}]`;
      await prisma.memory.update({
        where: { id },
        data: { resolution: "OPEN", content: newContent },
      });
      return { content: [{ type: "text", text: `Reopened "${existing.title}" (was ${existing.resolution}). selfSweep will re-evaluate.` }] };
    },
  );

  server.tool(
    "memory_search",
    "Memory search: hybrid scoring — semantic (pgvector) + ILIKE substring (CJK-friendly) + pg_trgm fuzzy (Latin-friendly) + entity-mention edges. Unified ranking, no short-circuit so a deterministic keyword query can outrank a vibe-only cosine neighbor. RESTRICTED excluded by default. includeContent=true returns the full body. Deep recall: scope='full' widens to the observation/profile/RESTRICTED/private pool, rerank=true runs a local cross-encoder re-rank — for oblique / semantic / whole-picture recall where the phrasing doesn't match the stored wording; slower but more precise. Default scope='default'+rerank=false = the fast default pool.",
    {
      query: z.string().describe("Natural-language query — semantic or keyword"),
      memoryType: z.enum(["CORE", "STATE", "EPISODE", "PREFERENCE", "BOUNDARY", "RESTRICTED"]).optional(),
      topicId: z.string().optional(),
      limit: z.number().default(10),
      includeContent: z.boolean().default(false).describe("true = return full content body, false = summary or first 200 chars of content"),
      scope: z.enum(["default", "full"]).default("default").describe("full = include observation/profile/RESTRICTED/private pool (only when no memoryType/topicId); default = memories table only, RESTRICTED excluded"),
      rerank: z.boolean().default(false).describe("true = local cross-encoder re-rank of the survivor pool (slower, better for oblique semantic recall; falls back gracefully to hybrid order if the server is unavailable)"),
    },
    async ({ query, memoryType, topicId, limit, includeContent, scope, rerank }) => {
      const body = (m: any) => (includeContent ? m.content : (m.summary || m.content.slice(0, 200)));

      // Single source of truth for hybrid scoring — embed → SQL CTE → JS
      // final weighting → filter → sort → slice — lives in lib/retrieval.ts
      // (scoreMemories). The eval harness calls the exact same function, so
      // there is no hand-copied SQL/weights drift. The text rendering below
      // (score breakdown line) is the tool's own surface and stays here.
      // scope/rerank default to the fast path — same behavior as before.
      const scored = await scoreMemories(query, {
        limit,
        memoryType,
        topicId,
        scope,
        components: rerank ? { rerank: true } : undefined,
      });

      // W_TIME mirrors the weight inside scoreMemories — used only to render
      // the time component's weighted contribution in the explainability line.
      const W_TIME = 0.10;

      if (scored.length === 0) {
        return { content: [{ type: "text", text: "No memories found." }] };
      }

      const text = scored
        .map((m: any) => {
          // Explainability line — extends the original (score/sem/kw/ent) with
          // the time decay + importance signals and the *named* entity edge(s)
          // that matched, so the reader sees why this memory came back. sem/kw
          // stay raw sims (unchanged meaning); time is its weighted
          // contribution; imp is the raw importance ratio. Single
          // human-readable line — every surface feeds it straight to the model,
          // no structured parsing.
          const time = (m.t * W_TIME).toFixed(2);
          const imp = ((Number(m.importance) || 3) / 5).toFixed(2);
          const via = m.via_entity
            ? ` via ${(m.entities && m.entities.length ? m.entities : ["?"]).join(",")}`
            : "";
          return `[${m.memoryType}] ${m.title} (imp:${m.importance}, score:${m.final.toFixed(2)} sem:${m.sem.toFixed(2)} kw:${m.kw.toFixed(2)} time:${time} imp:${imp}${via})\n${body(m)}`;
        })
        .join("\n\n---\n\n");
      return { content: [{ type: "text", text }] };
    },
  );

  // ── memory_search_safe ──────────────────────────────────────────────────
  // The non-sensitive subset of memory_search — for collaborating external
  // agents (any third-party client). It lets such a client read who the user
  // is / how they work / preferences / boundaries / state / recent context
  // without touching the sensitive layer. The public memory_search has two
  // sensitive paths (scope='full' includes the private/profile + RESTRICTED pool;
  // memoryType='RESTRICTED' fetches restricted directly), so a third-party allowlist
  // must never expose memory_search — only this tool. The server hard-locks
  // three independent layers, any one of which holds if the others fail:
  //   1. scope is always 'default' — never includes the private/observation/
  //      RESTRICTED pool;
  //   2. the memoryType enum excludes RESTRICTED/SELF_SCORE — can't request restricted or
  //      SELF introspection by name;
  //   3. each hit passes a public-facing content predicate and drops
  //      SELF_SCORE/experiencer=SELF — so sensitive text embedded in a single
  //      CORE/EPISODE row is filtered out. Prefer over-filtering (dropping a
  //      safe memory) to leaking anything sensitive.
  server.tool(
    "memory_search_safe",
    "Non-sensitive retrieval over the memory store — for collaborating external agents. Same hybrid scoring as memory_search (semantic pgvector + keyword + entity edges), but the server hard-locks it: always scope=default (never touches the private/profile / observation / RESTRICTED pool), refuses RESTRICTED/SELF_SCORE types, and runs each hit through a public-facing content predicate (dropped on match). Returns the clean part of CORE/PREFERENCE/BOUNDARY/STATE/EPISODE: who the user is, how they work, preferences/boundaries, current state, decisions and recent context. If nothing is found say so; do not fabricate.",
    {
      query: z.string().describe("Natural-language query — semantic or keyword"),
      memoryType: z
        .enum(["CORE", "STATE", "EPISODE", "PREFERENCE", "BOUNDARY"])
        .optional()
        .describe("Restrict to a type; unset = all non-RESTRICTED types. RESTRICTED is not an option (server does not expose it)."),
      limit: z.number().default(8),
      includeContent: z
        .boolean()
        .default(false)
        .describe("true = full body, false = summary or first 200 chars"),
    },
    async ({ query, memoryType, limit, includeContent }) => {
      // over-fetch: content filtering drops some, so fetch 3x then trim to limit
      const scored = await scoreMemories(query, {
        limit: limit * 3,
        memoryType,
        scope: "default", // hard-locked — never 'full'
      });

      const body = (m: any) =>
        includeContent ? m.content : m.summary || m.content.slice(0, 200);

      // Content filter covers every rendered/returned field — title + summary +
      // content. Must include summary: body() defaults to m.summary, and the
      // summary is independently written prose that may contain wording absent
      // from content. Drop on any field match.
      const clean = scored.filter(
        (m: any) =>
          m.memoryType !== "SELF_SCORE" &&
          m.experiencer !== "SELF" &&
          !publicSearchDrop(`${m.title || ""}\n${m.summary || ""}\n${m.content || ""}`),
      );

      if (clean.length === 0) {
        return { content: [{ type: "text", text: "No memories found." }] };
      }

      const text = clean
        .slice(0, limit)
        .map(
          (m: any) =>
            `[${m.memoryType}] ${m.title} (imp:${m.importance}, score:${m.final.toFixed(2)})\n${body(m)}`,
        )
        .join("\n\n---\n\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "memory_read",
    "Read recent memories or all memories of a type. RESTRICTED type excluded by default — pass memoryType=RESTRICTED to opt in. includeContent=true returns the full body.",
    {
      memoryType: z.enum(["CORE", "STATE", "EPISODE", "PREFERENCE", "BOUNDARY", "RESTRICTED"]).optional(),
      limit: z.number().default(20),
      includeContent: z.boolean().default(false).describe("true = return full content body, false = summary or first 200 chars of content"),
    },
    async ({ memoryType, limit, includeContent }) => {
      const body = (m: any) => (includeContent ? m.content : (m.summary || m.content.slice(0, 200)));
      const where = {
        isActive: true,
        ...(memoryType ? { memoryType } : { memoryType: { not: "RESTRICTED" as const } }),
      };
      const memories = await prisma.memory.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        include: { topic: true },
      });
      const text = memories.length
        ? memories
            .map(
              (m) =>
                `[${m.memoryType}] ${m.title} (importance: ${m.importance}, ${jstDate(m.createdAt)})\n${body(m)}`,
            )
            .join("\n\n---\n\n")
        : "No memories found.";
      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "graph_walk",
    "Walk the knowledge-graph `links` edges out from one node (memory/entity/topic/observation). Edge classes: memory→memory similar, entity→memory mentions, topic→memory tagged, entity↔entity co_mentioned. Bidirectional + multi-hop (1-3) BFS with cycle dedup. Use to find what a memory/entity/topic is connected to. Returns one line per reached node: label + relationType + confidence + hop depth.",
    {
      startId: z.string().describe("Node id (uuid) to start from"),
      startType: z
        .enum(["memory", "entity", "topic", "observation"])
        .describe("Type of the start node"),
      hops: z.number().min(1).max(3).default(1).describe("How many hops to expand (1-3)"),
      relationType: z
        .enum(["similar", "mentions", "tagged", "co_mentioned"])
        .optional()
        .describe("Only traverse this edge type"),
      minConfidence: z.number().default(0.55).describe("Minimum edge confidence"),
    },
    async ({ startId, startType, hops, relationType, minConfidence }) => {
      const nodes = await walkGraph({
        startIds: [startId],
        startType,
        hops,
        relationType,
        minConfidence,
        undirected: true,
      });
      if (nodes.length === 0) {
        return { content: [{ type: "text", text: "No connected nodes found." }] };
      }
      const text = nodes
        .map(
          (n) =>
            `[hop ${n.hop}] (${n.type}) ${n.label || "(no label)"} — ${n.relationType}, conf=${n.confidence.toFixed(2)}`,
        )
        .join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "memory_close",
    "Deactivate memories. Prefer id to close exactly one; titleMatch is a substring match that closes ALL hits (including a same-named new row), use it only when the title is known to be unique. Soft delete (isActive=false).",
    {
      id: z.string().optional().describe("Memory id — closes exactly this one, ignores titleMatch"),
      titleMatch: z.string().optional().describe("Substring to match against memory title. Note: closes all hits"),
      memoryType: z.enum(["CORE", "STATE", "EPISODE", "PREFERENCE", "BOUNDARY", "RESTRICTED"]).optional(),
    },
    async ({ id, titleMatch, memoryType }) => {
      if (!id && !titleMatch) return { content: [{ type: "text", text: "Pass id or titleMatch." }] };
      const where: any = id
        ? { id, isActive: true }
        : { isActive: true, title: { contains: titleMatch, mode: "insensitive" } };
      if (!id && memoryType) where.memoryType = memoryType;
      const matches = await prisma.memory.findMany({ where });
      if (!matches.length) return { content: [{ type: "text", text: `No active memory matched ${id ? `id ${id}` : `"${titleMatch}"`}.` }] };
      await prisma.memory.updateMany({
        where: { id: { in: matches.map((m) => m.id) } },
        data: { isActive: false },
      });
      return {
        content: [
          {
            type: "text",
            text: `Closed ${matches.length} memory(ies):\n${matches.map((m) => `[${m.memoryType}] ${m.title} (importance: ${m.importance})`).join("\n")}`,
          },
        ],
      };
    },
  );

  // ==========================================================================
  // Topics
  // ==========================================================================

  server.tool(
    "topic_create",
    "Create a new topic",
    {
      slug: z.string(),
      name: z.string(),
      summary: z.string().optional(),
      domain: z.enum(["WORK", "LOVE", "SYSTEM", "RESEARCH"]),
      priority: z.number().default(0),
    },
    async ({ slug, name, summary, domain, priority }) => {
      const topic = await prisma.topic.create({ data: { slug, name, summary, domain, priority } });
      return { content: [{ type: "text", text: `Topic created: ${topic.slug} — "${topic.name}"` }] };
    },
  );

  server.tool(
    "topic_list",
    "List all active topics",
    {
      domain: z.enum(["WORK", "LOVE", "SYSTEM", "RESEARCH"]).optional(),
    },
    async ({ domain }) => {
      const where = { status: "ACTIVE" as const, ...(domain ? { domain } : {}) };
      const topics = await prisma.topic.findMany({ where, orderBy: { priority: "desc" } });
      const text = topics.length ? topics.map((t) => `[${t.domain}] ${t.slug}: ${t.name}`).join("\n") : "No topics found.";
      return { content: [{ type: "text", text }] };
    },
  );

  // ==========================================================================
  // State
  // ==========================================================================

  server.tool(
    "state_set",
    "Set or update an active state. summary is required (>=20 chars); reentry reads only summary to avoid token blowup; content holds the full body, fetched on demand via state_get.",
    {
      stateType: z.enum(["HEALTH", "MOOD", "PROJECT", "STRESS", "RELATIONSHIP", "SCHEDULE", "SELF_CONCERN"]),
      title: z.string(),
      summary: z.string().min(20).describe("Short summary; reentry reads only this in the Active States section. Required, >=20 chars. Put the full body in the content field."),
      content: z.string(),
      source: z.string().optional(),
    },
    async ({ stateType, title, summary, content, source }) => {
      // self-concern v2: SELF_CONCERN no longer writes an ActiveState (that is
      // derive's job — a single writer). Instead write one Memory(SELF) and let
      // derive project it. This way a manual write no longer blanket-
      // deactivates concerns aggregated from other sources. Manual writes
      // default to the SUBJECTIVE tier (from conversation, no data/auto
      // evidence) — resolvable only by conversation / the user.
      if (stateType === "SELF_CONCERN") {
        const concernKey = `cc_${slugify(title)}`;
        await prisma.memory.create({
          data: {
            memoryType: "STATE",
            title,
            summary,
            content,
            importance: 4,
            sourceType: "MANUAL",
            experiencer: "SELF",
            grounding: "SUBJECTIVE",
            concernKey,
            resolution: "OPEN",
            valence: -0.3,
            arousal: 0.4,
          },
        });
        const d = await deriveConcerns();
        return {
          content: [
            { type: "text", text: `SELF_CONCERN → Memory(${concernKey}) + derived (active ${d.upserted}). v2: no longer writes ActiveState.` },
          ],
        };
      }
      // Non-SELF types upsert by (stateType+title) — same title updates,
      // different titles coexist. No blanket-deactivate of same-type old state
      // (the old singleton semantics would silently bump an earlier state).
      // Old state retires via state_close.
      const existing = await prisma.activeState.findFirst({
        where: { stateType, title, isActive: true },
        select: { id: true },
      });
      if (existing) {
        await prisma.activeState.update({
          where: { id: existing.id },
          data: { summary, content, source },
        });
        return { content: [{ type: "text", text: `State updated: [${stateType}] ${title}` }] };
      }
      const state = await prisma.activeState.create({ data: { stateType, title, summary, content, source } });
      return { content: [{ type: "text", text: `State set: [${state.stateType}] ${state.title}` }] };
    },
  );

  server.tool("state_read", "Read all current active states (full content).", {}, async () => {
    // raw + "stateType"::text — bypass enum deserialization so an unknown
    // StateType can't make state_read throw.
    const states = await prisma.$queryRaw<
      Array<{ stateType: string; title: string; content: string }>
    >`SELECT "stateType"::text AS "stateType", title, content FROM active_state WHERE "isActive" = true ORDER BY "startAt" DESC`;
    const text = states.length ? states.map((s) => `[${s.stateType}] ${s.title}: ${s.content}`).join("\n") : "No active states.";
    return { content: [{ type: "text", text }] };
  });

  server.tool(
    "state_get",
    "Fetch the full content of one state by id (reentry only gives the summary; use this to pull the body).",
    { id: z.string() },
    async ({ id }) => {
      // raw + "stateType"::text — single row by id, bypassing enum deserialization.
      const found = await prisma.$queryRaw<
        Array<{ id: string; stateType: string; title: string; summary: string | null; content: string; isActive: boolean }>
      >`SELECT id, "stateType"::text AS "stateType", title, summary, content, "isActive" FROM active_state WHERE id = ${id} LIMIT 1`;
      const state = found[0];
      if (!state) return { content: [{ type: "text", text: `State not found: ${id}` }] };
      return {
        content: [
          {
            type: "text",
            text: `[${state.stateType}] ${state.title}\nid: ${state.id}\nisActive: ${state.isActive}\nsummary: ${state.summary || "(none)"}\n\ncontent:\n${state.content}`,
          },
        ],
      };
    },
  );

  server.tool(
    "event_read",
    "Read recent events. Filter by type and/or source, default last 24h.",
    {
      eventType: z
        .enum(["CHAT", "APP_OPEN", "MANUAL_NOTE", "SYSTEM", "DREAM", "SCORE_FEEDBACK", "THOUGHT_HIT", "THOUGHT_RESOLVED"])
        .optional(),
      source: z.string().optional().describe("Filter by source field (substring match)"),
      hoursBack: z.number().default(24),
      limit: z.number().default(30),
    },
    async ({ eventType, source, hoursBack, limit }) => {
      const since = new Date(Date.now() - hoursBack * 3600 * 1000);
      const where: any = { createdAt: { gte: since } };
      if (eventType) where.eventType = eventType;
      if (source) where.source = { contains: source, mode: "insensitive" };
      const events = await prisma.event.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      if (!events.length) return { content: [{ type: "text", text: "No events." }] };
      const text = events
        .map((e) => `[${jst(e.createdAt)}] [${e.eventType}${e.source ? "/" + e.source : ""}] ${(e.value || "").slice(0, 240)}`)
        .join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  // ==========================================================================
  // Entities (V2 knowledge graph)
  // ==========================================================================

  server.tool(
    "entity_write",
    "Upsert an entity by name. entityType: PERSON / TOOL / PLATFORM / PROJECT / CONCEPT. A duplicate name updates its content and sets status ACTIVE.",
    {
      name: z.string().describe("Unique entity name (becomes upsert key)"),
      entityType: z.enum(["PERSON", "TOOL", "PLATFORM", "PROJECT", "CONCEPT"]),
      summary: z.string().optional().describe("Who/what, essential facts"),
    },
    async ({ name, entityType, summary }) => {
      const existing = await prisma.entity.findFirst({ where: { name } });
      if (existing) {
        await prisma.entity.update({
          where: { id: existing.id },
          data: { entityType, summary: summary ?? existing.summary, status: "ACTIVE" },
        });
        return { content: [{ type: "text", text: `Updated entity: ${name} [${entityType}]` }] };
      }
      const e = await prisma.entity.create({
        data: { name, entityType, summary, status: "ACTIVE" },
      });
      return { content: [{ type: "text", text: `Created entity: ${e.name} [${e.entityType}]` }] };
    },
  );

  server.tool(
    "entity_list",
    "List active entities, optionally filtered by type. Knowledge graph V2 — an overview of known people / tools / platforms / projects / concepts.",
    {
      entityType: z
        .enum(["PERSON", "TOOL", "PLATFORM", "PROJECT", "CONCEPT"])
        .optional(),
      limit: z.number().default(80),
    },
    async ({ entityType, limit }) => {
      const entities = await prisma.entity.findMany({
        where: { status: "ACTIVE", ...(entityType && { entityType }) },
        orderBy: [{ entityType: "asc" }, { name: "asc" }],
        take: limit,
      });
      if (entities.length === 0) return { content: [{ type: "text", text: "No entities." }] };
      const text = entities
        .map((e) => `[${e.entityType}] ${e.name}${e.summary ? ` — ${e.summary.slice(0, 140)}` : ""}`)
        .join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "entity_search",
    "Search entities by name or summary substring (case-insensitive).",
    { query: z.string(), limit: z.number().default(10) },
    async ({ query, limit }) => {
      const entities = await prisma.entity.findMany({
        where: {
          status: "ACTIVE",
          OR: [
            { name: { contains: query, mode: "insensitive" } },
            { summary: { contains: query, mode: "insensitive" } },
          ],
        },
        orderBy: { name: "asc" },
        take: limit,
      });
      if (entities.length === 0) return { content: [{ type: "text", text: "No match." }] };
      const text = entities
        .map((e) => `[${e.entityType}] ${e.name}${e.summary ? `\n  ${e.summary}` : ""}`)
        .join("\n\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "entity_close",
    "Deactivate an entity (status=INACTIVE) by exact name. Not deleted — historical references remain queryable. Use when an entity is merged or no longer relevant.",
    { name: z.string() },
    async ({ name }) => {
      const r = await prisma.entity.updateMany({
        where: { name, status: "ACTIVE" },
        data: { status: "INACTIVE" },
      });
      return {
        content: [
          {
            type: "text",
            text: r.count > 0 ? `Closed entity: ${name}` : `No active entity named "${name}".`,
          },
        ],
      };
    },
  );

  server.tool(
    "state_close",
    "Deactivate an active state by title match (substring, case-insensitive). Use when a state is resolved or no longer applies.",
    {
      titleMatch: z.string().describe("Substring to match against state title"),
    },
    async ({ titleMatch }) => {
      // raw + "stateType"::text — id for updateMany, stateType/title for the confirmation message.
      const matches = await prisma.$queryRaw<Array<{ id: string; stateType: string; title: string }>>`
        SELECT id, "stateType"::text AS "stateType", title FROM active_state
        WHERE "isActive" = true AND title ILIKE ${"%" + titleMatch + "%"}
      `;
      if (!matches.length) return { content: [{ type: "text", text: `No active state matched "${titleMatch}".` }] };
      await prisma.activeState.updateMany({
        where: { id: { in: matches.map((s) => s.id) } },
        data: { isActive: false, endAt: new Date() },
      });
      return {
        content: [
          { type: "text", text: `Closed ${matches.length} state(s):\n${matches.map((s) => `[${s.stateType}] ${s.title}`).join("\n")}` },
        ],
      };
    },
  );

  // ==========================================================================
  // Profile (private_ keys are siphoned off to private_read)
  // ==========================================================================

  server.tool("profile_read", "Read all core profile entries (private_* keys are excluded — use private_read for those)", {}, async () => {
    const entries = await prisma.coreProfile.findMany({
      where: { isActive: true, NOT: { key: { startsWith: "private_" } } },
      orderBy: { importance: "desc" },
    });
    const text = entries.length
      ? entries.map((e) => `[${e.key}] ${e.title} (importance: ${e.importance})\n${e.content}`).join("\n\n---\n\n")
      : "No profile entries.";
    return { content: [{ type: "text", text }] };
  });

  server.tool(
    "private_read",
    "Read private_* profile entries — the restricted profile tier.",
    {},
    async () => {
      const entries = await prisma.coreProfile.findMany({
        where: { isActive: true, key: { startsWith: "private_" } },
        orderBy: { importance: "desc" },
      });
      const text = entries.length
        ? entries.map((e) => `[${e.key}] ${e.title} (importance: ${e.importance})\n${e.content}`).join("\n\n---\n\n")
        : "No private entries.";
      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "profile_set",
    "Set or update a core profile entry",
    {
      key: z.string().describe("Profile key"),
      title: z.string(),
      content: z.string(),
      importance: z.number().min(1).max(5).default(3),
      source: z.string().optional(),
    },
    async ({ key, title, content, importance, source }) => {
      const entry = await prisma.coreProfile.upsert({
        where: { key },
        update: { title, content, importance, source },
        create: { key, title, content, importance, source },
      });
      return { content: [{ type: "text", text: `Profile set: [${entry.key}] ${entry.title}` }] };
    },
  );

  // ==========================================================================
  // Events
  // ==========================================================================

  server.tool(
    "event_log",
    "Log an event",
    {
      eventType: z.enum([
        "CHAT",
        "APP_OPEN",
        "MANUAL_NOTE",
        "SYSTEM",
        "DREAM",
        "SCORE_FEEDBACK",
        "THOUGHT_HIT",
        "THOUGHT_RESOLVED",
      ]),
      value: z.string().optional(),
      source: z.string().optional(),
    },
    async ({ eventType, value, source }) => {
      const event = await prisma.event.create({ data: { eventType, value, source } });
      return { content: [{ type: "text", text: `Event logged: [${event.eventType}] ${event.value || ""}` }] };
    },
  );

  // ==========================================================================
  // Observation upsert (standalone — for mid-conversation use)
  // ==========================================================================

  server.tool(
    "observation_write",
    [
      "Upsert one structured observation about the user or the assistant. Same shape as closeout's keyObservations slot, but standalone — call mid-conversation when a long-term character signal lands. Avoids firing a full closeout just to record one observation.",
      "",
      "Use this for a cross-session accumulating character pattern — NOT one-off facts:",
      "- user_X: the user's personality / behavior pattern / preference observation",
      "- self_X: the assistant's own register / mechanism / catch",
      "",
      "key is a snake_case unique index — writing the same key updates in place, no duplicate. importance>=4 enters notification surfaces, >=3 enters reentry.",
      "",
      "One-off facts / concrete facts / momentary mood → memory_write, not observation_write.",
    ].join("\n"),
    {
      subject: z.enum(["user", "self"]).describe("Observation subject — the user or the assistant"),
      key: z
        .string()
        .describe("Unique key (snake_case). Same key is an upsert."),
      title: z.string(),
      content: z.string(),
      importance: z.number().min(1).max(5).default(3),
      author: z.string().optional().describe("Who recorded the observation. Default 'assistant'"),
    },
    async ({ subject, key, title, content, importance, author }) => {
      const r = await prisma.observation.upsert({
        where: { key },
        create: { subject, key, title, content, importance, author: author ?? "assistant" },
        update: { subject, title, content, importance, author: author ?? "assistant", isActive: true },
      });
      return {
        content: [
          {
            type: "text",
            text: `Observation upserted: [${r.subject}] ${r.title} (key=${r.key}, importance=${r.importance})`,
          },
        ],
      };
    },
  );

  // ==========================================================================
  // Context builder
  // ==========================================================================

  server.tool(
    "reentry",
    [
      "Build full context for a new conversation window. Call this at the start of every new session to load profile, active states, recent memories, topics, and recent chat.",
      "tag: window identifier (suggested cc-YYMMDDHHMM, using the boot timestamp). If passed, it drops a tagged boot anchor; this window's later reentry_delta calls use the same tag so deltas always anchor to this window's own boot/marker, unaffected by other windows advancing the main chain.",
    ].join("\n"),
    { tag: z.string().optional().describe("Window identifier, paired with this window's later reentry_delta tag. Suggested cc-YYMMDDHHMM.") },
    async ({ tag }) => {
      const profile = await prisma.coreProfile.findMany({
        where: { isActive: true, NOT: { key: { startsWith: "private_" } } },
        orderBy: { importance: "desc" },
      });
      // raw + "stateType"::text — reentry is every new window's cold start; if
      // this throws on an unknown StateType the whole reentry fails to start.
      // Bypass enum deserialization.
      const states = await prisma.$queryRaw<
        Array<{ id: string; stateType: string; title: string; summary: string | null; content: string }>
      >`SELECT id, "stateType"::text AS "stateType", title, summary, content FROM active_state WHERE "isActive" = true ORDER BY "startAt" DESC`;
      const topics = await prisma.topic.findMany({ where: { status: "ACTIVE" }, orderBy: { priority: "desc" } });
      // Filter RESTRICTED — reentry is a harness-visible cold-start surface; RESTRICTED is
      // not injected here. memory_search / private_read can opt in explicitly.
      //
      // Two queries by altitude:
      // - anchors: CORE/BOUNDARY/PREFERENCE, full content (the rule is the body)
      // - episodes: EPISODE importance>=4, top 20, sliced to 300 (narrative)
      // BOUNDARY is the container for behavioral rules. Pure-technical rows are
      // excluded from reentry via the externalized cold-start filter (still
      // queryable via memory_search).
      const anchors = (await prisma.memory.findMany({
        where: {
          isActive: true,
          memoryType: { in: ["CORE", "BOUNDARY", "PREFERENCE"] },
        },
        orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
        include: { topic: true },
      })).filter((m: any) =>
        // Cold-start exclusion (tech-only titles, sensitive prefixes, and any
        // private content predicate) is externalized — see lib/reentry-filter.
        // Ships neutral (no exclusions) in the open-source core.
        !isColdStartExcluded(m.title, `${m.title ?? ""} ${m.summary ?? ""} ${m.content ?? ""}`)
      );
      // Observations (structured reads about the user / assistant). reentry
      // importance>=3. Replaces stuffing user_* / self_* observations into CORE.
      const observations = (await prisma.observation.findMany({
        where: { isActive: true, importance: { gte: 3 } },
        orderBy: [{ subject: "asc" }, { importance: "desc" }, { updatedAt: "desc" }],
      })).filter((o: any) => !isColdStartExcluded(o.title, `${o.title ?? ""} ${o.content ?? ""}`));
      const episodes = (await prisma.memory.findMany({
        where: {
          isActive: true,
          memoryType: "EPISODE",
          importance: { gte: 4 },
          // CHAT+SHARED go through the digests section below; exclude here to avoid duplication.
          NOT: { AND: [{ sourceType: "CHAT" }, { experiencer: "SHARED" }] },
        },
        orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
        take: 20,
        include: { topic: true },
      })).filter((m: any) => !isColdStartExcluded(m.title, `${m.title ?? ""} ${m.summary ?? ""} ${m.content ?? ""}`));
      const recentEvents = await prisma.event.findMany({
        where: { NOT: { source: { in: ["reentry", "reentry_delta"] } } },
        orderBy: { createdAt: "desc" },
        take: 10,
      });
      // Dialogue digests (sanitized) instead of raw CHAT — raw may contain
      // sensitive content that a cold session reentry should not expose. The
      // digest layer is produced sanitized; the cold-start content filter is a
      // second layer on top (externalized, ships neutral).
      const digests = (await prisma.memory.findMany({
        where: {
          isActive: true,
          memoryType: "EPISODE",
          sourceType: "CHAT",
          experiencer: "SHARED",
        },
        orderBy: { createdAt: "desc" },
        take: 15,
      })).filter((d: any) => !isColdStartExcluded(d.title, `${d.title ?? ""} ${d.summary ?? ""} ${d.content ?? ""}`)).slice(0, 10);

      let ctx = "# Re-entry Context\n\n## Core Profile\n\n";
      ctx += profile.length
        ? profile.map((e) => `**${e.title}** (${e.key}, importance: ${e.importance})\n${e.content}`).join("\n\n")
        : "No profile data.\n";

      ctx += "\n\n## Active States\n\n";
      // state content dumped in full blows up reentry token count; read only
      // summary, with a null fallback slice(300)+'...' + a warn nudging backfill.
      // Fetch the full body on-demand via state_get(id).
      ctx += states.length
        ? states
            .map((s) => {
              if (s.summary) return `- [${s.stateType}] ${s.title} (id: ${s.id}): ${s.summary}`;
              console.warn(`[reentry] state "${s.title}" (${s.id}) missing summary, using slice fallback — please backfill via state_set`);
              return `- [${s.stateType}] ${s.title} (id: ${s.id}): ${s.content.slice(0, 300)}${s.content.length > 300 ? "..." : ""}`;
            })
            .join("\n")
        : "No active states.\n";

      ctx += "\n\n## Active Topics\n\n";
      ctx += topics.length
        ? topics.map((t) => `- [${t.domain}] **${t.name}** (${t.slug}): ${t.summary || ""}`).join("\n")
        : "No active topics.\n";

      ctx += "\n\n## Anchors & Rules (CORE / BOUNDARY / PREFERENCE)\n\n";
      // anchors soften by type + importance. BOUNDARY: full body (the rule body
      // is the rule, slicing breaks it). CORE importance=5: full body (identity
      // signature / commitments / relationship frame must not lose its tail).
      // CORE importance<=4 + all PREFERENCE: summary || slice(500) (analytical
      // content; 500 chars keeps the first half of the arc).
      const renderAnchor = (m: any) => {
        if (m.memoryType === "BOUNDARY") return m.content;
        if (m.memoryType === "CORE" && m.importance === 5) return m.content;
        const fallback = m.content.length > 500
          ? m.content.slice(0, 500) + "..."
          : m.content;
        return m.summary || fallback;
      };
      ctx += anchors.length
        ? anchors
            .map(
              (m) => `**${m.title}** [${m.memoryType}, importance: ${m.importance}]\n${renderAnchor(m)}`,
            )
            .join("\n\n---\n\n")
        : "No anchors.\n";

      ctx += "\n\n## Observations (structured reads about the user / assistant)\n\n";
      ctx += observations.length
        ? observations
            .map(
              (o) => `**[${o.subject}] ${o.title}** (${o.key}, importance: ${o.importance})\n${o.content}`,
            )
            .join("\n\n---\n\n")
        : "No observations.\n";

      ctx += "\n\n## Recent Episodes (importance>=4)\n\n";
      ctx += episodes.length
        ? episodes
            .map(
              (m) =>
                `**${m.title}** [${m.memoryType}, importance: ${m.importance}]\n${m.summary || m.content.slice(0, 300)}`,
            )
            .join("\n\n---\n\n")
        : "No recent episodes.\n";

      ctx += "\n\n## Recent dialogue digests (sanitized · past memory, not the current conversation)\n";
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      ctx += digests.length
        ? digests.map((d) => {
            const isRecent = d.createdAt >= oneWeekAgo;
            const body = isRecent
              ? (d.summary || d.content).slice(0, 300)
              : (d.summary || d.content.slice(0, 100));
            // Relative-age label per line — titles are not guaranteed to carry a
            // date, so without it a cold-start reentry can read a days-old digest
            // as if it were the current conversation.
            const ageDays = Math.floor((Date.now() - d.createdAt.getTime()) / 86_400_000);
            const ageLabel = ageDays <= 0 ? "today" : `${ageDays}d ago`;
            return `- [${ageLabel}] ${d.title}: ${body}`;
          }).join("\n")
        : "- (none — the digest layer produces these automatically)";

      ctx += "\n\n## Recent Events\n\n";
      ctx += recentEvents.length
        ? recentEvents.map((e) => `- [${e.eventType}] ${e.value || ""} (${jst(e.createdAt)})`).join("\n")
        : "No recent events.\n";

      // Boot marker — gives reentry_delta a "this window's start" anchor (placed
      // after the query, not included in this output). value=tag: a same-tag
      // delta first-call anchors here, not the global latest boot (which could
      // be another window).
      await prisma.event.create({ data: { eventType: "SYSTEM", source: "reentry", value: tag } });

      return { content: [{ type: "text", text: ctx }] };
    },
  );

  // ==========================================================================
  // Context delta — incremental reentry (new/updated since last delta or this window's boot)
  // ==========================================================================

  server.tool(
    "reentry_delta",
    [
      "Incremental reentry: pull context new/updated since the last delta call (or this window's reentry boot).",
      "In a long conversation the reentry snapshot goes stale (frozen at boot); this tool fills the delta, each row tagged [NEW]/[UPD].",
      "Default (no args) = advancing watermark: anchor at the last reentry_delta marker; else the most recent reentry boot; else a 6h fallback. A no-arg call drops a new marker advancing the chain, so calling twice the second sees only what's truly new.",
      "override: since(ISO) or sinceMinutes — a one-shot look-back that does not advance the marker chain.",
      "tag: multi-window isolation, each with its own marker chain, default main. If reentry passed the same tag at boot, this chain's first call anchors at this window's own boot — true isolation; otherwise the first call falls back to the global latest boot.",
      "Sections mirror reentry (States/Anchors/Episodes/Observations/Digests/Topics/Profile/Events), RESTRICTED filtered as usual. Empty sections are hidden.",
    ].join("\n"),
    {
      since: z.string().optional().describe("ISO lower bound. One-shot override, does not advance the marker chain."),
      sinceMinutes: z.number().optional().describe("Look back N minutes. One-shot override, does not advance the marker chain."),
      tag: z.string().optional().describe("Marker chain identifier, multi-window isolation. Default main."),
    },
    async ({ since: sinceISO, sinceMinutes, tag }) => {
      const chainTag = tag ?? "main";
      const explicit = !!(sinceISO || sinceMinutes);
      let since: Date;
      let anchorSrc: string;
      if (sinceISO) {
        since = new Date(sinceISO);
        anchorSrc = `explicit since ${sinceISO}`;
      } else if (sinceMinutes) {
        since = new Date(Date.now() - sinceMinutes * 60_000);
        anchorSrc = `last ${sinceMinutes}min`;
      } else {
        const lastDelta = await prisma.event.findFirst({
          where: { eventType: "SYSTEM", source: "reentry_delta", value: chainTag },
          orderBy: { createdAt: "desc" },
        });
        if (lastDelta) {
          since = lastDelta.createdAt;
          anchorSrc = `last reentry_delta (${jst(lastDelta.createdAt)})`;
        } else {
          // First look for a same-tag boot anchor (dropped by reentry with a
          // tag); else fall back to the global latest boot. The global fallback
          // can let memories written after this window's boot fall through a
          // gap if another window's boot/marker is newer; a tagged boot chain
          // does not have that gap.
          let lastReentry = await prisma.event.findFirst({
            where: { eventType: "SYSTEM", source: "reentry", value: chainTag },
            orderBy: { createdAt: "desc" },
          });
          let bootSrc = `this window's reentry boot [tag=${chainTag}]`;
          if (!lastReentry) {
            lastReentry = await prisma.event.findFirst({
              where: { eventType: "SYSTEM", source: "reentry" },
              orderBy: { createdAt: "desc" },
            });
            bootSrc = "most recent reentry boot (global, no same-tag boot)";
          }
          if (lastReentry) {
            since = lastReentry.createdAt;
            anchorSrc = `${bootSrc} (${jst(lastReentry.createdAt)})`;
          } else {
            since = new Date(Date.now() - 360 * 60_000);
            anchorSrc = "fallback 6h (no marker)";
          }
        }
      }

      const recent = { OR: [{ createdAt: { gte: since } }, { updatedAt: { gte: since } }] };
      const mark = (createdAt: Date) => (createdAt >= since ? "NEW" : "UPD");

      // States (raw + ::text — same as reentry, guards against unknown enum throw)
      const states = await prisma.$queryRaw<
        Array<{ id: string; stateType: string; title: string; summary: string | null; content: string; createdAt: Date }>
      >`SELECT id, "stateType"::text AS "stateType", title, summary, content, "createdAt"
        FROM active_state
        WHERE "isActive" = true
          AND ("createdAt" >= ${since} OR "updatedAt" >= ${since} OR "startAt" >= ${since})
        ORDER BY "startAt" DESC`;

      // delta shares the reentry main function's cold-start exclusion
      // (externalized, ships neutral).
      const anchors = (await prisma.memory.findMany({
        where: { isActive: true, memoryType: { in: ["CORE", "BOUNDARY", "PREFERENCE"] }, ...recent },
        orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
      })).filter((m: any) => !isColdStartExcluded(m.title, `${m.title ?? ""} ${m.summary ?? ""} ${m.content ?? ""}`));

      const observations = (await prisma.observation.findMany({
        where: { isActive: true, importance: { gte: 3 }, ...recent },
        orderBy: [{ subject: "asc" }, { importance: "desc" }, { updatedAt: "desc" }],
      })).filter((o: any) => !isColdStartExcluded(o.title, `${o.title ?? ""} ${o.content ?? ""}`));

      const episodes = (await prisma.memory.findMany({
        where: {
          isActive: true,
          memoryType: "EPISODE",
          importance: { gte: 4 },
          NOT: { AND: [{ sourceType: "CHAT" }, { experiencer: "SHARED" }] },
          ...recent,
        },
        orderBy: { createdAt: "desc" },
        take: 30,
      })).filter((m: any) => !isColdStartExcluded(m.title, `${m.title ?? ""} ${m.summary ?? ""} ${m.content ?? ""}`));

      const digests = (await prisma.memory.findMany({
        where: { isActive: true, memoryType: "EPISODE", sourceType: "CHAT", experiencer: "SHARED", ...recent },
        orderBy: { createdAt: "desc" },
        take: 30,
      })).filter((m: any) => !isColdStartExcluded(m.title, `${m.title ?? ""} ${m.summary ?? ""} ${m.content ?? ""}`));

      const topics = await prisma.topic.findMany({ where: { status: "ACTIVE", ...recent }, orderBy: { priority: "desc" } });
      const profile = await prisma.coreProfile.findMany({
        where: { isActive: true, NOT: { key: { startsWith: "private_" } }, ...recent },
        orderBy: { importance: "desc" },
      });
      const events = await prisma.event.findMany({
        where: {
          createdAt: { gte: since },
          eventType: { not: "APP_OPEN" },
          NOT: { source: { in: ["reentry", "reentry_delta"] } },
        },
        orderBy: { createdAt: "desc" },
        take: 40,
      });

      const renderAnchor = (m: any) => {
        if (m.memoryType === "BOUNDARY") return m.content;
        if (m.memoryType === "CORE" && m.importance === 5) return m.content;
        const fb = m.content.length > 500 ? m.content.slice(0, 500) + "..." : m.content;
        return m.summary || fb;
      };

      let ctx = `# Re-entry Delta\n\nSince ${jst(since)} (anchor: ${anchorSrc}, tag=${chainTag})\n`;
      let any = false;

      if (states.length) {
        any = true;
        ctx += "\n## Active States Δ\n\n";
        ctx += states
          .map((s) => `- [${mark(s.createdAt)}][${s.stateType}] ${s.title} (id: ${s.id}): ${s.summary || s.content.slice(0, 300)}`)
          .join("\n");
      }
      if (anchors.length) {
        any = true;
        ctx += "\n\n## Anchors Δ (CORE / BOUNDARY / PREFERENCE)\n\n";
        ctx += anchors
          .map((m: any) => `**[${mark(m.createdAt)}] ${m.title}** [${m.memoryType}, importance: ${m.importance}]\n${renderAnchor(m)}`)
          .join("\n\n---\n\n");
      }
      if (observations.length) {
        any = true;
        ctx += "\n\n## Observations Δ\n\n";
        ctx += observations
          .map((o) => `**[${mark(o.createdAt)}][${o.subject}] ${o.title}** (${o.key}, importance: ${o.importance})\n${o.content}`)
          .join("\n\n---\n\n");
      }
      if (episodes.length) {
        any = true;
        ctx += "\n\n## Episodes Δ (importance>=4)\n\n";
        ctx += episodes
          .map((m) => `**[${mark(m.createdAt)}] ${m.title}** [importance: ${m.importance}]\n${m.summary || m.content.slice(0, 300)}`)
          .join("\n\n---\n\n");
      }
      if (digests.length) {
        any = true;
        ctx += "\n\n## Dialogue digests Δ (sanitized)\n\n";
        ctx += digests.map((d) => `- [${mark(d.createdAt)}] ${d.title}: ${(d.summary || d.content).slice(0, 300)}`).join("\n");
      }
      if (topics.length) {
        any = true;
        ctx += "\n\n## Topics Δ\n\n";
        ctx += topics.map((t) => `- [${mark(t.createdAt)}][${t.domain}] **${t.name}** (${t.slug}): ${t.summary || ""}`).join("\n");
      }
      if (profile.length) {
        any = true;
        ctx += "\n\n## Profile Δ\n\n";
        ctx += profile.map((e) => `**[${mark(e.createdAt)}] ${e.title}** (${e.key}, importance: ${e.importance})\n${e.content}`).join("\n\n");
      }
      if (events.length) {
        any = true;
        ctx += "\n\n## Events Δ\n\n";
        ctx += events.map((e) => `- [${e.eventType}] ${e.value || ""} (${jst(e.createdAt)})`).join("\n");
      }

      if (!any) ctx += `\nNothing new since ${jst(since)}.`;

      // Advance the marker chain — only on a default (no explicit override) call.
      if (!explicit) {
        await prisma.event.create({ data: { eventType: "SYSTEM", source: "reentry_delta", value: chainTag } });
        ctx += `\n\n_marker advanced (tag=${chainTag})_`;
      }

      return { content: [{ type: "text", text: ctx }] };
    },
  );

  // ==========================================================================
  // Closeout
  // ==========================================================================

  server.tool(
    "closeout",
    [
      "End-of-session routine. Saves an episode summary, updates active states, and logs a session-end event.",
      "Call this before a conversation window closes.",
      "",
      "Episode writing principle — layer, don't repeat:",
      "Concrete facts already written into other tables mid-session (entity/memory/observation/state/profile)",
      "get a one-line mention in the episode ('discussed X'), not an expansion. The episode records only the",
      "connections between those facts:",
      "- emotional arc: where the session started and ended, how the mood moved",
      "- relationship shift: what is different between the parties after this session",
      "- the heaviest few lines said (key quoted phrases)",
      "- carryover: threads left unresolved",
      "",
      "Importance rules for keyMemories:",
      "1. Pure system/technical memory → importance 3.",
      "2. Important technical progress goes in active_state(PROJECT), not memory.",
      "3. importance 4-5 only for relationship / life content.",
    ].join("\n"),
    {
      episodeTitle: z.string().describe("Title for this session episode"),
      episodeSummary: z.string().describe("This session's emotional arc + relationship trajectory. Do not repeat concrete facts already written into entity/memory/observation/state."),
      keyMemories: z
        .array(
          z.object({
            title: z.string(),
            summary: z.string().describe("Summary, <=300 chars. (1) do not repeat title (2) cover the full arc — cause / course / conclusion (3) keep the most important concrete details (numbers / names / key quoted phrases) (4) note any unresolved carryover."),
            content: z.string(),
            memoryType: z.enum(["CORE", "STATE", "EPISODE", "PREFERENCE", "BOUNDARY", "RESTRICTED"]).default("EPISODE"),
            importance: z.number().min(1).max(5).default(3),
            topicSlug: z.string().optional(),
            valence: z.number().min(-1).max(1).optional().describe("This memory's closing valence (-1~1). Used by satiety logic to judge how the session settled."),
            bondClosure: z.boolean().optional().describe("Whether this closing settled via bonding (factual layer). Combined with valence>0 it lets the relevant drive ease off (both required)."),
          }),
        )
        .optional()
        .describe("Key memories to extract and save from this session"),
      stateUpdates: z
        .array(
          z.object({
            stateType: z.enum(["HEALTH", "MOOD", "PROJECT", "STRESS", "RELATIONSHIP", "SCHEDULE", "SELF_CONCERN"]),
            title: z.string(),
            summary: z.string().min(20).describe("Short summary >=20 chars; reentry reads only this."),
            content: z.string(),
          }),
        )
        .optional()
        .describe("Active states to set or update"),
      pendingItems: z
        .array(
          z.object({
            title: z.string(),
            content: z.string(),
            pendingType: z
              .enum(["MEMORY_CANDIDATE", "TOPIC_LINK", "DIGEST", "DIARY_NOTE", "QUEUE_MESSAGE"])
              .default("MEMORY_CANDIDATE"),
          }),
        )
        .optional()
        .describe("Items to leave pending for next session review"),
      keyObservations: z
        .array(
          z.object({
            subject: z.enum(["user", "self"]).describe("Observation subject — the user or the assistant"),
            key: z.string().describe("Unique key (snake_case), used for upsert."),
            title: z.string(),
            content: z.string(),
            importance: z.number().min(1).max(5).default(3),
            author: z.string().optional().describe("Who recorded the observation. Default 'assistant'"),
          }),
        )
        .optional()
        .describe("Structured observations about the subject. Upsert by key. importance>=4 enters notification surfaces, >=3 enters reentry."),
      selfScore: z
        .object({
          valence: z.number().min(-1).max(1).describe("-1 to 1, the session's overall emotional sign"),
          arousal: z.number().min(0).max(1).describe("0 to 1, emotional intensity"),
          note: z.string().describe("one line on the current state"),
          concernKey: z
            .string()
            .optional()
            .describe("Only when this session exposed a recurring, still-uncorrected behavioral failure AND valence is negative: a stable slug (reuse, don't coin new ones). Setting it routes this self-score to OPEN+EVIDENCE; after recurring across days it surfaces as a SELF_CONCERN tracked until corrected. Leave empty for one-off emotion / positive sessions."),
        })
        .optional()
        .describe("Session self-assessment. Write it even if not asked — closeout must include selfScore."),
      genuinelyRecalled: z
        .array(z.string())
        .optional()
        .describe("Memory IDs genuinely thought about this session (not tool-retrieval). Only relationship-relevant. Increments activationCount."),
      authorModel: z
        .string()
        .describe("Instrument attribution (required): the model id of the session calling closeout. The episode / self-score / keyMemories are all attributed to this instrument."),
    },
    async ({ episodeTitle, episodeSummary, keyMemories, stateUpdates, pendingItems, keyObservations, selfScore, genuinelyRecalled, authorModel }) => {
      const results: string[] = [];

      const episode = await prisma.memory.create({
        data: {
          title: episodeTitle,
          summary: episodeSummary.slice(0, 300),
          content: episodeSummary,
          memoryType: "EPISODE",
          importance: 4,
          sourceType: "CHAT",
          authorModel,
        },
      });
      // closeout previously bypassed memory_write's post-write pipeline — the
      // embedding waited for the nightly sweep and entity→memory edges were
      // never built. The episode is a heavy retrieval target, so build both
      // here; failure swallowed, the sweep is the safety net.
      try {
        const epEmb = await embedText(`${episode.title}\n${episodeSummary.slice(0, 300)}`);
        if (epEmb) {
          await prisma.$executeRaw`UPDATE memories SET embedding = ${toVectorLiteral(epEmb)}::vector, "embeddingAt" = NOW() WHERE id = ${episode.id}`;
        }
        await sweepMemoryMentions(episode.id);
      } catch (e: any) {
        console.warn("[closeout] episode embed/mention failed:", e?.message ?? e);
      }
      results.push(`Episode saved: "${episode.title}"`);

      if (selfScore) {
        const today = localDate(new Date());
        // negative valence + a tagged concernKey = a recurring behavioral
        // failure → routes into the concern pipeline (OPEN/EVIDENCE; the
        // relapse gate lives in deriveConcerns). Otherwise a self-score is a
        // snapshot, default RESOLVED. The bare slug (no prefix) must match the
        // one memory_write uses so relapses aggregate across paths. A v<=-0.6
        // strong-negative falls back to a key even when untagged (mirrors
        // memory_write's badsession fallback).
        const ssKey = selfScore.valence < 0
          ? selfScore.concernKey
            ? slugify(selfScore.concernKey)
            : selfScore.valence <= -0.6
              ? `badsession_${today}`
              : null
          : null;
        await prisma.memory.create({
          data: {
            title: `self-score ${today}`,
            summary: selfScore.note,
            content: selfScore.note,
            memoryType: "SELF_SCORE",
            experiencer: "SELF",
            resolution: ssKey ? "OPEN" : "RESOLVED",
            grounding: ssKey ? "EVIDENCE" : undefined,
            concernKey: ssKey ?? undefined,
            valence: selfScore.valence,
            arousal: selfScore.arousal,
            importance: 3,
            sourceType: "CHAT",
            authorModel,
          },
        });
        results.push(`Self-score: v=${selfScore.valence} a=${selfScore.arousal}${ssKey ? ` [concern ${ssKey}]` : ""} "${selfScore.note}"`);
      }

      const savedMemoryIds: { id: string; title: string; summary: string }[] = [];
      if (keyMemories?.length) {
        for (const mem of keyMemories) {
          let topicId: string | undefined;
          if (mem.topicSlug) {
            const topic = await prisma.topic.findUnique({ where: { slug: mem.topicSlug } });
            if (topic) topicId = topic.id;
          }
          const created = await prisma.memory.create({
            data: {
              title: mem.title,
              summary: mem.summary,
              content: mem.content,
              memoryType: mem.memoryType,
              importance: mem.importance,
              sourceType: "CHAT",
              topicId,
              valence: mem.valence ?? null,
              bondClosure: mem.bondClosure ?? false,
              authorModel,
            },
          });
          savedMemoryIds.push({ id: created.id, title: created.title, summary: mem.summary });
          // Depth fallback: qualifying memories with no topic get an async depth
          // judgment. Fire-and-forget.
          void tagDepthIfNeeded({ id: created.id, title: mem.title, content: mem.content, memoryType: mem.memoryType, importance: mem.importance, topicId: topicId ?? null });
        }
        results.push(`${keyMemories.length} memories saved`);
      }

      if (stateUpdates?.length) {
        let derivedAfterCloseout = false;
        for (const state of stateUpdates) {
          // self-concern v2: SELF_CONCERN → Memory(SELF), derive projects it (no ActiveState).
          if (state.stateType === "SELF_CONCERN") {
            await prisma.memory.create({
              data: {
                memoryType: "STATE",
                title: state.title,
                summary: state.summary,
                content: state.content,
                importance: 4,
                sourceType: "CHAT",
                experiencer: "SELF",
                grounding: "SUBJECTIVE",
                concernKey: `cc_${slugify(state.title)}`,
                resolution: "OPEN",
                valence: -0.3,
                arousal: 0.4,
                authorModel,
              },
            });
            derivedAfterCloseout = true;
            continue;
          }
          // Same as state_set: (stateType+title) upsert, no singleton replacement.
          const existingState = await prisma.activeState.findFirst({
            where: { stateType: state.stateType, title: state.title, isActive: true },
            select: { id: true },
          });
          if (existingState) {
            await prisma.activeState.update({
              where: { id: existingState.id },
              data: { summary: state.summary, content: state.content, source: "closeout" },
            });
          } else {
            await prisma.activeState.create({
              data: { stateType: state.stateType, title: state.title, summary: state.summary, content: state.content, source: "closeout" },
            });
          }
        }
        if (derivedAfterCloseout) { await deriveConcerns(); await deriveDrives(); }
        results.push(`${stateUpdates.length} states updated`);
      }

      if (pendingItems?.length) {
        for (const item of pendingItems) {
          await prisma.pendingItem.create({
            data: { pendingType: item.pendingType, title: item.title, content: item.content },
          });
        }
        results.push(`${pendingItems.length} pending items saved`);
      }

      if (keyObservations?.length) {
        for (const obs of keyObservations) {
          await prisma.observation.upsert({
            where: { key: obs.key },
            create: {
              subject: obs.subject,
              key: obs.key,
              title: obs.title,
              content: obs.content,
              importance: obs.importance ?? 3,
              author: obs.author ?? "assistant",
            },
            update: {
              subject: obs.subject,
              title: obs.title,
              content: obs.content,
              importance: obs.importance ?? 3,
              author: obs.author ?? "assistant",
              isActive: true,
            },
          });
        }
        results.push(`${keyObservations.length} observations upserted`);
      }

      // Memory V3 — build relation edges for new keyMemories
      if (savedMemoryIds.length) {
        let edgesCreated = 0;
        for (const saved of savedMemoryIds) {
          // entity→memory edges: memory_write builds them; closeout used to skip them.
          try { await sweepMemoryMentions(saved.id); } catch (e: any) {
            console.warn("[closeout] mention sweep failed:", e?.message ?? e);
          }
          const searchText = `${saved.title} ${saved.summary}`;
          const emb = await embedText(searchText);
          if (!emb) continue;
          const vec = toVectorLiteral(emb);
          // Write the computed embedding into the row too — previously it was
          // computed only to build edges and then discarded, leaving the row
          // without a vector until the nightly sweep.
          await prisma.$executeRaw`UPDATE memories SET embedding = ${vec}::vector, "embeddingAt" = NOW() WHERE id = ${saved.id}`;
          const related: any[] = await prisma.$queryRaw`
            SELECT id, title, (embedding <=> ${vec}::vector) AS distance
            FROM memories
            WHERE "isActive" = true AND embedding IS NOT NULL
              AND id::text != ${saved.id}
            ORDER BY embedding <=> ${vec}::vector
            LIMIT 3
          `;
          for (const r of related) {
            const conf = 1.0 - Number(r.distance);
            if (conf < 0.3) continue;
            await prisma.link.create({
              data: {
                fromType: "memory",
                fromId: saved.id,
                toType: "memory",
                toId: r.id,
                relationType: "similar",
                confidence: Math.round(conf * 100) / 100,
                note: `auto-linked at closeout (cosine sim ${conf.toFixed(2)})`,
              },
            });
            edgesCreated++;
          }
        }
        if (edgesCreated > 0) results.push(`${edgesCreated} relation edges created`);
      }

      // Memory V3 — increment activationCount for genuinely recalled memories.
      // Don't bump updatedAt: activation is not a content edit, and bumping it
      // would make the sweep think the embedding is stale and re-embed on every
      // recall.
      if (genuinelyRecalled?.length) {
        await prisma.$executeRaw`
          UPDATE memories
          SET "activationCount" = "activationCount" + 1
          WHERE id::text = ANY(${genuinelyRecalled})
        `;
        results.push(`${genuinelyRecalled.length} memories activation incremented`);
      }

      await prisma.event.create({
        data: { eventType: "CHAT", value: `Session closed: ${episodeTitle}`, source: "closeout" },
      });
      results.push("Session end event logged");

      return { content: [{ type: "text", text: `Closeout complete:\n- ${results.join("\n- ")}` }] };
    },
  );

  // ==========================================================================
  // Register profiles (speaking-style presets)
  // ==========================================================================

  server.tool(
    "register_set",
    "Create or update a register profile (speaking-style preset)",
    {
      name: z.string().describe("Register name, e.g. default / work / love / gentle / serious"),
      mode: z.enum(["WORK", "LOVE", "MIXED"]).default("MIXED"),
      toneKeywords: z.string().optional().describe("Tone keywords"),
      preferredAddressing: z.string().optional(),
      forbiddenPhrases: z.string().optional(),
      preferredPhrases: z.string().optional(),
      verbosityStyle: z.enum(["SHORT", "MEDIUM", "LONG"]).default("MEDIUM"),
      initiativeStyle: z.enum(["PASSIVE", "LOW", "ACTIVE"]).default("LOW"),
      comfortStyle: z.enum(["EXPLAIN", "COMPANION", "NO_EMPTY_COMFORT"]).default("EXPLAIN"),
      exampleSnippets: z.string().optional(),
      priority: z.number().default(0),
    },
    async (data) => {
      const entry = await prisma.registerProfile.upsert({
        where: { name: data.name },
        update: data,
        create: data,
      });
      return { content: [{ type: "text", text: `Register: [${entry.name}] mode=${entry.mode}` }] };
    },
  );

  server.tool("register_read", "Read all register profiles", {}, async () => {
    const profiles = await prisma.registerProfile.findMany({
      where: { isActive: true },
      orderBy: { priority: "desc" },
    });
    if (!profiles.length) return { content: [{ type: "text", text: "No register profiles." }] };
    const text = profiles
      .map(
        (p) =>
          `[${p.name}] mode=${p.mode}, verbosity=${p.verbosityStyle}, initiative=${p.initiativeStyle}\n  tone: ${p.toneKeywords || "-"}\n  addressing: ${p.preferredAddressing || "-"}`,
      )
      .join("\n\n");
    return { content: [{ type: "text", text }] };
  });
}
