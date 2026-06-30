// Embedding backfill sweep — re-embeds rows whose embedding is missing or stale.
// Lives in lib/ (not the intel daemon entry) so it stays a side-effect-free,
// testable module. intel's daily run calls sweepNullEmbeddings().

import { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { embedAndStore, staleEmbeddingWhere, type EmbeddableTable } from "./embed.js";

// Sweep rows whose embedding is missing or stale (STALE_EMBEDDING_WHERE: NULL —
// newly written / cleared — or content edited after creation with the embedding
// not following) and re-embed them. Covers all three embeddable tables; memories
// was inline in intel while observations + core_profile lived in a one-off migrate
// script. Per-run limits are cost bounds (memories carries the most churn → 500).
//
// observations note: upsert is frequent (unique key); a raw UPDATE does not bump
// Prisma's @updatedAt, so this sweep never pushes updatedAt forward and will not
// self-trigger on a row it just embedded.
export const SWEEP_TABLES: ReadonlyArray<{
  table: EmbeddableTable;
  limit: number;
  // memories embeds title + (summary || content); the other two have no summary
  // column, so they select + embed title + content only.
  needsSummary: boolean;
  embedInput: (row: any) => string;
}> = [
  { table: "memories", limit: 500, needsSummary: true, embedInput: (r) => `${r.title}\n${r.summary || r.content}` },
  { table: "observations", limit: 100, needsSummary: false, embedInput: (r) => `${r.title}\n${r.content}` },
  { table: "core_profile", limit: 100, needsSummary: false, embedInput: (r) => `${r.title}\n${r.content}` },
];

// Re-embed one table's stale rows. The column list is a fixed pair (the boolean
// picks whether `summary` is included) and the table name comes from the typed
// config above — never free user text, so the Prisma.raw splices carry no
// injection surface. Returns (attempted, patched) for that table.
export async function sweepTable(cfg: (typeof SWEEP_TABLES)[number]): Promise<{ patched: number; attempted: number }> {
  const cols = cfg.needsSummary
    ? Prisma.raw("id, title, content, summary")
    : Prisma.raw("id, title, content");
  const rows: any[] = await prisma.$queryRaw(Prisma.sql`
    SELECT ${cols} FROM ${Prisma.raw(cfg.table)}
    WHERE "isActive" = true AND (${staleEmbeddingWhere()})
    LIMIT ${cfg.limit}
  `);
  let patched = 0;
  for (const row of rows) {
    if (await embedAndStore(cfg.table, row.id, cfg.embedInput(row))) patched++;
  }
  return { patched, attempted: rows.length };
}

export async function sweepNullEmbeddings(): Promise<{ patched: number; attempted: number }> {
  let patched = 0, attempted = 0;
  for (const cfg of SWEEP_TABLES) {
    const r = await sweepTable(cfg);
    patched += r.patched;
    attempted += r.attempted;
  }
  return { patched, attempted };
}
