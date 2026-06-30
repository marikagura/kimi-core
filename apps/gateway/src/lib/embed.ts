// Embeddings wrapper — an OpenAI-compatible /embeddings endpoint, brought by the
// deployer (EMBED_BASE_URL + EMBED_API_KEY + EMBED_MODEL; no preset). Plus the ONE
// place embeddings are written to the DB. Returns null on any failure — call sites
// gracefully fall back to keyword/trigram search.
//
// Input truncated to 8k chars (~2k tok) as a safety cap — longer inputs cost more
// without proportional quality gain for the memory/digest/profile use case.

import { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { fetchWithRetry } from "../fetch-retry.js";
import { embedModelOrNull, embedBaseUrlOrNull, embedApiKeyOrNull } from "./models.js";
import { errMessage } from "./err.js";

// The embedding dimension the DB vector columns are declared with (vector(1536) in
// schema.prisma + the 0_init migration). EMBED_MODEL MUST produce this many dims;
// a mismatch is caught loudly in embedText below instead of failing at the DB.
export const EMBED_DIM = 1536;

export async function embedText(text: string): Promise<number[] | null> {
  const model = embedModelOrNull();
  const base = embedBaseUrlOrNull();
  const key = embedApiKeyOrNull();
  if (!model || !base || !key) {
    console.warn("[embed] EMBED_MODEL / EMBED_BASE_URL / EMBED_API_KEY not all set — skipping (no semantic arm)");
    return null;
  }
  if (!text || text.trim().length === 0) return null;

  try {
    const res = await fetchWithRetry(`${base}/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
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
    const data = (await res.json()) as { data?: Array<{ embedding?: unknown }> };
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
    if (!emb.every((x) => typeof x === "number" && Number.isFinite(x))) {
      // A right-length array with a null/NaN/string element (a buggy/partial provider
      // response) would produce a literal like '[...,null,...]' that pgvector's
      // ::vector cast rejects — and in retrieval.ts that cast is in the LIVE query, so
      // it would throw the whole memory_search instead of degrading to keyword-only.
      // Return null here to keep the "never throw from the embed path" contract.
      console.error("[embed] response contained a non-finite element — skipping");
      return null;
    }
    return emb as number[];
  } catch (err: unknown) {
    console.error("[embed] failed:", errMessage(err));
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
  // Stamp the producing model so a same-dimension EMBED_MODEL swap is detectable —
  // STALE_EMBEDDING_WHERE re-embeds any row whose stamped model != the current one.
  const model = embedModelOrNull();
  await prisma.$executeRaw(
    Prisma.sql`UPDATE ${Prisma.raw(`"${table}"`)} SET embedding = ${vec}::vector, "embeddingAt" = NOW(), "embedModel" = ${model} WHERE id = ${id}`,
  );
}

// Clear a row's embedding so the sweep is guaranteed to re-embed it. Used when a
// text EDIT re-embed fails inline: the row still holds the OLD-text vector, but
// `updatedAt > createdAt + 1 minute` is FALSE for an edit within ~1 min of creation,
// so STALE_EMBEDDING_WHERE's edit arm never fires and the stale vector would persist
// forever. Nulling it re-arms the unconditional `embedding IS NULL` arm.
export async function clearEmbedding(table: EmbeddableTable, id: string): Promise<void> {
  await prisma.$executeRaw(
    Prisma.sql`UPDATE ${Prisma.raw(`"${table}"`)} SET embedding = NULL, "embeddingAt" = NULL WHERE id = ${id}`,
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
// embedded (NULL), edited after creation with the embedding not following, OR
// embedded by a DIFFERENT model than the current EMBED_MODEL (a same-dimension swap
// the dim guard can't see). The model arm only fires when embedModel is non-null and
// differs, so legacy rows with an unknown (NULL) model are left alone — no surprise
// full re-embed on the deploy that adds the column.
export function staleEmbeddingWhere(): Prisma.Sql {
  const model = embedModelOrNull();
  const modelArm = model
    ? Prisma.sql` OR ("embedModel" IS NOT NULL AND "embedModel" <> ${model})`
    : Prisma.empty;
  return Prisma.sql`embedding IS NULL OR ("updatedAt" > "createdAt" + interval '1 minute' AND ("embeddingAt" IS NULL OR "embeddingAt" < "updatedAt"))${modelArm}`;
}
