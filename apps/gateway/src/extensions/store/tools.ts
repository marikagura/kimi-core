// Store extension MCP tool: `store` — structured CRUD over the store_rows table
// (calendar / sleep / keepsakes / study / memory-worldbook rows for front-ends),
// independent of the memory engine. Unlike the agent-text memory tools, this
// returns JSON (in a text block) for a surface to consume programmatically. One
// uniform table keyed by `collection`; the op switch mirrors kimi-room's
// src/app/api/store/route.ts so the two stay byte-compatible.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "../../db.js";
import { isColdStartExcluded } from "../../lib/reentry-filter.js";
import {
  BLOB_COLLECTION,
  applyFilter,
  blobToRow,
  entryToRow,
  importToRows,
  mergeEntry,
  newId,
  nowISO,
  rowToBlob,
  rowToEntry,
  rowsToExport,
  searchRows,
  type BlobEntry,
  type Filter,
  type StoreRow,
} from "./store-shared.js";

type DbRow = {
  id: string;
  collection: string;
  data: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
};

function toStoreRow(r: DbRow): StoreRow {
  return {
    id: r.id,
    collection: r.collection,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    data: (r.data ?? {}) as Record<string, unknown>,
  };
}

function toInput(row: StoreRow) {
  return {
    id: row.id,
    collection: row.collection,
    data: row.data as Prisma.InputJsonValue,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

async function upsertRow(row: StoreRow): Promise<void> {
  const input = toInput(row);
  await prisma.storeRow.upsert({
    where: { id: input.id },
    create: input,
    update: input,
  });
}

export function registerStoreTools(server: McpServer): void {
  server.tool(
    "store",
    "Structured CRUD for front-end surfaces (kimi-room / kimi-manor) over the store_rows store — calendar, sleep, keepsakes, study, memory-worldbook, etc. Distinct from the memory engine: returns JSON (in a text block), not agent-text. One uniform table keyed by `collection`; pass `op` to choose the operation.",
    {
      op: z.enum([
        "list",
        "get",
        "put",
        "delete",
        "search",
        "blobList",
        "blobGet",
        "blobPut",
        "blobDelete",
        "export",
        "import",
        "empty",
      ]),
      collection: z.string().optional().describe("Collection name (e.g. calendar / sleep / keepsake)"),
      id: z.string().optional(),
      entry: z.unknown().optional().describe("Row body for put (object)"),
      blob: z.unknown().optional().describe("Blob body for blobPut (kind/contentType/base64)"),
      query: z.string().optional().describe("Search query for op=search"),
      filter: z.unknown().optional().describe("List filter (ids/tags/status/activeOnly/dateRange/limit)"),
      kind: z.string().optional().describe("Blob kind filter for op=blobList"),
      json: z.string().optional().describe("Export JSON string for op=import"),
    },
    async (args) => {
      const collection = args.collection ?? "";
      try {
        let result: unknown;
        switch (args.op) {
          case "list": {
            const rows = await prisma.storeRow.findMany({ where: { collection } });
            const entries = rows.map((r) => rowToEntry(toStoreRow(r)));
            result = applyFilter(entries, args.filter as Filter | undefined);
            break;
          }
          case "get": {
            const row = args.id
              ? await prisma.storeRow.findUnique({ where: { id: args.id } })
              : null;
            result =
              row && row.collection === collection ? rowToEntry(toStoreRow(row)) : null;
            break;
          }
          case "put": {
            const entry = (args.entry ?? {}) as Record<string, unknown> & { id?: string };
            const prev = entry.id
              ? await prisma.storeRow.findUnique({ where: { id: entry.id } })
              : null;
            const existing =
              prev && prev.collection === collection ? rowToEntry(toStoreRow(prev)) : null;
            const merged = mergeEntry(existing, entry, nowISO());
            await upsertRow(entryToRow(collection, merged));
            result = merged;
            break;
          }
          case "delete": {
            if (args.id) {
              await prisma.storeRow.deleteMany({ where: { id: args.id, collection } });
            }
            result = null;
            break;
          }
          case "search": {
            const rows = await prisma.storeRow.findMany({ where: { collection } });
            const entries = rows.map((r) => rowToEntry(toStoreRow(r)));
            result = searchRows(entries, args.query ?? "");
            break;
          }
          case "blobList": {
            const rows = await prisma.storeRow.findMany({
              where: { collection: BLOB_COLLECTION },
            });
            let blobs = rows.map((r) => rowToBlob(toStoreRow(r)));
            if (args.kind) blobs = blobs.filter((b) => b.kind === args.kind);
            result = blobs;
            break;
          }
          case "blobGet": {
            const row = args.id
              ? await prisma.storeRow.findUnique({ where: { id: args.id } })
              : null;
            result =
              row && row.collection === BLOB_COLLECTION ? rowToBlob(toStoreRow(row)) : null;
            break;
          }
          case "blobPut": {
            const b = (args.blob ?? {}) as Partial<BlobEntry> & { id?: string };
            const full: BlobEntry = {
              id: b.id ?? newId(),
              kind: String(b.kind ?? "misc"),
              contentType: String(b.contentType ?? "application/octet-stream"),
              base64: String(b.base64 ?? ""),
              createdAt: nowISO(),
            };
            await upsertRow(blobToRow(full));
            result = full;
            break;
          }
          case "blobDelete": {
            if (args.id) {
              await prisma.storeRow.deleteMany({
                where: { id: args.id, collection: BLOB_COLLECTION },
              });
            }
            result = null;
            break;
          }
          case "export": {
            const rows = await prisma.storeRow.findMany();
            result = JSON.stringify(rowsToExport(rows.map(toStoreRow)), null, 2);
            break;
          }
          case "import": {
            const rows = importToRows(
              JSON.parse(args.json ?? "{}") as Record<string, unknown[]>,
            );
            for (const row of rows) await upsertRow(row);
            result = { added: rows.length };
            break;
          }
          case "empty": {
            await prisma.storeRow.deleteMany({});
            result = null;
            break;
          }
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: (e as Error).message }) },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "state_snapshot",
    "Read-only composed snapshot for a dashboard surface (e.g. kimi-manor): core profile, active states, topics, recent episodes, an active-memory count, and the full store_rows grouped by collection. Returns NEUTRAL structured JSON — the surface maps it to its own render shape. The same cold-start exclusion as reentry applies (ships neutral / no exclusions in the open core).",
    {},
    async () => {
      try {
        const profile = await prisma.coreProfile.findMany({
          where: { isActive: true, NOT: { key: { startsWith: "private_" } } },
          orderBy: { importance: "desc" },
          select: { key: true, title: true, content: true, importance: true },
        });
        // raw + ::text to bypass enum deserialization (an unknown StateType would
        // otherwise throw and fail the whole snapshot), mirroring reentry.
        const states = await prisma.$queryRaw<
          Array<{ id: string; stateType: string; title: string; summary: string | null }>
        >`SELECT id, "stateType"::text AS "stateType", title, summary FROM active_state WHERE "isActive" = true ORDER BY "startAt" DESC`;
        const topics = await prisma.topic.findMany({
          where: { status: "ACTIVE" },
          orderBy: { priority: "desc" },
          select: { domain: true, name: true, slug: true, summary: true },
        });
        const episodesRaw = await prisma.memory.findMany({
          where: { isActive: true, memoryType: "EPISODE", importance: { gte: 4 } },
          orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
          take: 20,
          select: { title: true, summary: true, content: true, importance: true, createdAt: true },
        });
        const recentEpisodes = episodesRaw
          .filter(
            (m) =>
              !isColdStartExcluded(
                m.title ?? "",
                `${m.title ?? ""} ${m.summary ?? ""} ${m.content ?? ""}`,
              ),
          )
          .map((m) => ({
            title: m.title,
            summary: m.summary ?? m.content.slice(0, 300),
            importance: m.importance,
            createdAt: m.createdAt.toISOString(),
          }));
        const memoryActive = await prisma.memory.count({ where: { isActive: true } });
        const storeRows = await prisma.storeRow.findMany();
        const store = rowsToExport(
          storeRows.map((r) => ({
            id: r.id,
            collection: r.collection,
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
            data: (r.data ?? {}) as Record<string, unknown>,
          })),
        );
        const snapshot = {
          generatedAt: nowISO(),
          profile,
          states,
          topics,
          recentEpisodes,
          memoryStats: { active: memoryActive },
          store,
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(snapshot) }] };
      } catch (e) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: (e as Error).message }) },
          ],
          isError: true,
        };
      }
    },
  );
}
