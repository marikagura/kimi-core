// ============================================================================
// Memory domain tool registry.
// memory_write / memory_edit / memory_reopen / memory_search / memory_search_safe /
// memory_read / graph_walk / memory_close
// ============================================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import prisma from "./db.js";
import { localDate } from "./time.js";
import { indexNewMemory } from "./lib/memory-index.js";
import { scoreMemories } from "./lib/retrieval.js";
import { walkGraph } from "./lib/graph-walk.js";
import { tagDepthIfNeeded } from "./lib/depth-judge.js";
import { errMessage } from "./lib/err.js";
import { publicSearchDrop } from "./lib/reentry-filter.js";
import { getNotifier } from "./lib/providers.js";

export function registerMemoryTools(server: McpServer) {
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
      // Embedding + entity→memory mention edges (shared with closeout via
      // indexNewMemory). Each arm swallows its own failure — the row is already
      // saved; the nightly sweeps backfill anything that fails here.
      await indexNewMemory(memory.id, `${title}\n${summary || content}`, { logTag: "memory_write" });

      // Depth fallback: qualifying memories with no topic get an async depth
      // judgment so an untagged depth memory still gets tagged. Fire-and-forget.
      void tagDepthIfNeeded({ id: memory.id, title, content, memoryType, importance, topicId: resolvedTopicId ?? null });

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
      } catch (e: unknown) {
        console.warn("[memory_write] breadcrumb event failed:", errMessage(e));
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
    "Memory search: hybrid scoring — semantic (pgvector) + ILIKE substring (CJK-friendly) + pg_trgm fuzzy (Latin-friendly) + entity-mention edges. Unified ranking, no short-circuit so a deterministic keyword query can outrank a cosine-similarity neighbor. RESTRICTED excluded by default. includeContent=true returns the full body. Deep recall: scope='full' widens to the observation/profile/RESTRICTED/private pool, rerank=true runs a local cross-encoder re-rank — for oblique / semantic / whole-picture recall where the phrasing doesn't match the stored wording; slower. Default scope='default'+rerank=false = the fast default pool.",
    {
      query: z.string().describe("Natural-language query — semantic or keyword"),
      memoryType: z.enum(["CORE", "STATE", "EPISODE", "PREFERENCE", "BOUNDARY", "RESTRICTED"]).optional(),
      topicId: z.string().optional(),
      limit: z.number().default(10),
      includeContent: z.boolean().default(false).describe("true = return full content body, false = summary or first 200 chars of content"),
      scope: z.enum(["default", "full"]).default("default").describe("full = include observation/profile/RESTRICTED/private pool (only when no memoryType/topicId); default = memories table only, RESTRICTED excluded"),
      rerank: z.boolean().default(false).describe("true = local cross-encoder re-rank of the survivor pool (slower; for oblique semantic recall; falls back to hybrid order if the server is unavailable)"),
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
                `[${m.memoryType}] ${m.title} (importance: ${m.importance}, ${localDate(m.createdAt)})\n${body(m)}`,
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

  server.tool(
    "memory_edit",
    "Edit the content fields of one existing memory (title / summary / content / importance) by id — only the fields you pass change. USER-GATED: call this ONLY when the user has explicitly asked to change a specific memory. Never autonomously rewrite a recorded memory — an edit overwrites history. `authorization` must quote the user's instruction that asked for the edit. (Not in the autonomous daemon's read-only allowlist, so it can only run with a human in the loop.)",
    {
      id: z.string().describe("Memory id to edit"),
      authorization: z
        .string()
        .describe("The user's explicit instruction that asked for this edit — quote them. Required: edits are user-gated; do not edit a memory the user did not ask you to change."),
      title: z.string().optional().describe("New title (omit to keep)"),
      summary: z.string().optional().describe("New summary, <=300 chars (omit to keep)"),
      content: z.string().optional().describe("New content (omit to keep)"),
      importance: z.number().min(1).max(5).optional().describe("New importance 1-5 (omit to keep)"),
    },
    async ({ id, authorization, title, summary, content, importance }) => {
      if (!authorization || !authorization.trim()) {
        return {
          content: [{ type: "text" as const, text: "authorization required: memory_edit is user-gated — pass the user's instruction that asked for this edit." }],
          isError: true,
        };
      }
      const existing = await prisma.memory.findUnique({
        where: { id },
        select: { id: true, title: true, summary: true, content: true },
      });
      if (!existing) {
        return { content: [{ type: "text", text: `Memory ${id} not found.` }] };
      }
      const data: { title?: string; summary?: string; content?: string; importance?: number } = {};
      if (title !== undefined) data.title = title;
      if (summary !== undefined) data.summary = summary;
      if (content !== undefined) data.content = content;
      if (importance !== undefined) data.importance = importance;
      if (Object.keys(data).length === 0) {
        return { content: [{ type: "text", text: "Nothing to edit — pass at least one of title / summary / content / importance." }] };
      }
      await prisma.memory.update({ where: { id }, data });

      // Re-index the embedding when a text field changed, or search goes stale.
      if (title !== undefined || summary !== undefined || content !== undefined) {
        const newTitle = title ?? existing.title;
        const newSummary = summary ?? existing.summary;
        const newContent = content ?? existing.content;
        await indexNewMemory(id, `${newTitle}\n${newSummary || newContent}`, { logTag: "memory_edit" });
      }

      // Audit breadcrumb — which fields changed + the user authorization that gated it.
      try {
        await prisma.event.create({
          data: {
            eventType: "SYSTEM",
            source: "memory_edit",
            value: JSON.stringify({ id, fields: Object.keys(data), authorization: authorization.slice(0, 300) }),
          },
        });
      } catch (e: unknown) {
        console.warn("[memory_edit] breadcrumb event failed:", errMessage(e));
      }

      // Review notification — so any edit (especially an unwanted one) is visible
      // out-of-band and can be rolled back. Routes through the pluggable notifier
      // (NOTIFIER env: console default / webhook). Best-effort; never blocks.
      void getNotifier()
        .send({
          content: `memory_edit: ${id} — changed ${Object.keys(data).join(", ")} · authorized: "${authorization.slice(0, 80)}"`,
          slug: `memory-edit-${id}`,
        })
        .catch((e: unknown) => console.warn("[memory_edit] notify failed:", errMessage(e)));

      return { content: [{ type: "text", text: `Edited memory ${id} — changed ${Object.keys(data).join(", ")}.` }] };
    },
  );
}
