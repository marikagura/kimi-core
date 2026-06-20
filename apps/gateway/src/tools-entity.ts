// ============================================================================
// Entity domain tool registry (V2 knowledge graph).
// entity_write / entity_list / entity_search / entity_close
// ============================================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import prisma from "./db.js";

export function registerEntityTools(server: McpServer) {
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
}
