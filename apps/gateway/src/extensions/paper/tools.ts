// Paper extension MCP tools: paper_search + paper_write over the paper_notes
// store (an academic layer, independent of the memory engine). Registered via the
// extension's registerTools hook — not part of the core tool set.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import prisma from "../../db.js";

export function registerPaperTools(server: McpServer): void {
  server.tool(
    "paper_write",
    "Write one academic knowledge point to the paper_notes store (separate from memory / topics / KG). Dedup by externalId (source UID): updates if it already exists. Used by the paper loop and for manual notes.",
    {
      title: z.string().describe("Paper title"),
      knowledge: z.string().describe("Distilled knowledge: key findings / methods / takeaways"),
      externalId: z.string().optional().describe("Source UID (e.g. a PubMed UID) — dedup key"),
      journal: z.string().optional(),
      authors: z.string().optional(),
      url: z.string().optional(),
      publishedAt: z.string().optional().describe("ISO date"),
      relevance: z.string().optional().describe("Why it matters / which research axis it connects to"),
      axis: z.string().optional().describe("Free-text academic-axis tag"),
      hasFullText: z.boolean().optional().describe("Full text obtained vs abstract only"),
      importance: z.number().min(1).max(5).optional(),
    },
    async ({ title, knowledge, externalId, journal, authors, url, publishedAt, relevance, axis, hasFullText, importance }) => {
      const data = {
        title, knowledge, journal, authors, url,
        publishedAt: publishedAt ? new Date(publishedAt) : undefined,
        relevance, axis,
        hasFullText: hasFullText ?? undefined,
        importance: importance ?? undefined,
      };
      if (externalId) {
        const existing = await prisma.paperNote.findUnique({ where: { externalId }, select: { id: true } });
        if (existing) {
          await prisma.paperNote.update({ where: { id: existing.id }, data });
          return { content: [{ type: "text", text: `Updated paper_note (${externalId}): ${title.slice(0, 70)}` }] };
        }
      }
      await prisma.paperNote.create({ data: { ...data, externalId, hasFullText: hasFullText ?? false, importance: importance ?? 3 } });
      return { content: [{ type: "text", text: `Wrote paper_note [${axis ?? "-"}]: ${title.slice(0, 70)}` }] };
    },
  );

  server.tool(
    "paper_search",
    "Search the paper_notes store: keyword over title / knowledge / relevance + optional axis filter. Separate from memory_search.",
    {
      query: z.string().describe("Keyword / topic"),
      axis: z.string().optional().describe("Filter by academic axis"),
      limit: z.number().optional(),
    },
    async ({ query, axis, limit }) => {
      const notes = await prisma.paperNote.findMany({
        where: {
          isActive: true,
          ...(axis ? { axis } : {}),
          OR: [
            { title: { contains: query, mode: "insensitive" } },
            { knowledge: { contains: query, mode: "insensitive" } },
            { relevance: { contains: query, mode: "insensitive" } },
          ],
        },
        orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
        take: Math.min(limit ?? 10, 30),
        select: { title: true, journal: true, authors: true, knowledge: true, relevance: true, axis: true, url: true, hasFullText: true },
      });
      if (notes.length === 0) return { content: [{ type: "text", text: `No paper_notes matched "${query}"${axis ? ` (axis ${axis})` : ""}.` }] };
      const text = notes
        .map((n) => `[${n.axis ?? "-"}${n.hasFullText ? "" : " · abstract-only"}] ${n.title}${n.journal ? ` — ${n.journal}` : ""}\n  knowledge: ${n.knowledge}${n.relevance ? `\n  relevance: ${n.relevance}` : ""}${n.url ? `\n  ${n.url}` : ""}`)
        .join("\n\n");
      return { content: [{ type: "text", text }] };
    },
  );
}
