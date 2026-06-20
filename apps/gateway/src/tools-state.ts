// ============================================================================
// State / topic / event domain tool registry.
// topic_create / topic_list / state_set / state_read / state_get /
// state_close / event_read / event_log
// ============================================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import prisma from "./db.js";
import { localDateTime } from "./time.js";
import { deriveConcerns, slugify } from "./lib/concern-derive.js";
import { SELF_CONCERN_DEFAULTS, upsertActiveState } from "./tools-shared.js";

export function registerStateTools(server: McpServer) {
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
            ...SELF_CONCERN_DEFAULTS,
            title,
            summary,
            content,
            sourceType: "MANUAL",
            concernKey,
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
      const { created } = await upsertActiveState({ stateType, title, summary, content, source });
      return {
        content: [{ type: "text", text: `${created ? "State set" : "State updated"}: [${stateType}] ${title}` }],
      };
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
        .map((e) => `[${localDateTime(e.createdAt)}] [${e.eventType}${e.source ? "/" + e.source : ""}] ${(e.value || "").slice(0, 240)}`)
        .join("\n");
      return { content: [{ type: "text", text }] };
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
}
