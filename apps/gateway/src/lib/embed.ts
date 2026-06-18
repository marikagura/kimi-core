// OpenAI embeddings wrapper (model via EMBED_MODEL; no built-in default) plus the
// ONE place embeddings are written to the DB. Returns null on any failure — call
// sites gracefully fall back to keyword/trigram search.
//
// Input truncated to 8k chars (~2k tok) as a safety cap — longer inputs cost more
// without proportional quality gain for the memory/digest/profile use case.

import { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { fetchWithRetry } from "../fetch-retry.js";
import { embedModelOrNull } from "./models.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY;

// The embedding dimension the DB vector columns are declared with (vector(1536) in
// schema.prisma + the 0_init migration). EMBED_MODEL MUST produce this many dims;
// a mismatch is caught loudly in embedText below instead of failing at the DB.
export const EMBED_DIM = 1536;

export async function embedText(text: string): Promise<number[] | null> {
  const model = embedModelOrNull();
  if (!OPENAI_KEY || !model) {
    console.warn("[embed] OPENAI_API_KEY or EMBED_MODEL not set — skipping (no semantic arm)");
    return null;
  }
  if (!text || text.trim().length === 0) return null;

  try {
    const res = await fetchWithRetry("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: text.slice(0, 8000),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[embed] openai ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data: any = await res.json();
    const emb = data?.data?.[0]?.embedding;
    if (!Array.isArray(emb)) {
      console.error("[embed] unexpected response shape");
      return null;
    }
    if (emb.length !== EMBED_DIM) {
      // Fail loud, not silently: a wrong-dim model would otherwise throw deep in a
      // raw ::vector insert. Skip the write; the row stays null for the sweep.
      console.error(`[embed] EMBED_MODEL "${model}" returned ${emb.length} dims, expected ${EMBED_DIM} (the DB vector column width). Use a ${EMBED_DIM}-dim model or change the schema.`);
      return null;
    }
    return emb;
  } catch (err: any) {
    console.error("[embed] failed:", err?.message || err);
    return null;
  }
}

// Format a Float[] as a pgvector literal string for raw SQL.
// vector(EMBED_DIM) accepts '[0.1,0.2,...]'.
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

// Tables carrying an (embedding, embeddingAt) pair.
export type EmbeddableTable = "memories" | "observations" | "core_profile";

// The ONE place the ::vector cast + the embeddingAt=NOW() freshness convention
// live. Every embedding write goes through here, so the sweep's "needs re-embed"
// predicate (STALE_EMBEDDING_WHERE) and the write can never drift apart — a write
// that forgot embeddingAt would make the row read as stale and re-embed forever.
export async function writeEmbedding(table: EmbeddableTable, id: string, emb: number[]): Promise<void> {
  const vec = toVectorLiteral(emb);
  await prisma.$executeRaw(
    Prisma.sql`UPDATE ${Prisma.raw(`"${table}"`)} SET embedding = ${vec}::vector, "embeddingAt" = NOW() WHERE id = ${id}`,
  );
}

// Compute + store in one step. Returns true if an embedding was written, false if
// embedText returned null (no key/model, empty text, dim mismatch) — the row is
// then left for the nightly sweep.
export async function embedAndStore(table: EmbeddableTable, id: string, text: string): Promise<boolean> {
  const emb = await embedText(text);
  if (!emb) return false;
  await writeEmbedding(table, id, emb);
  return true;
}

// "This active row needs (re)embedding" — the read-side counterpart to the
// embeddingAt=NOW() write convention. One definition for all three tables: never
// embedded (NULL), or edited after creation with the embedding not following.
export const STALE_EMBEDDING_WHERE = Prisma.sql`embedding IS NULL OR ("updatedAt" > "createdAt" + interval '1 minute' AND ("embeddingAt" IS NULL OR "embeddingAt" < "updatedAt"))`;
