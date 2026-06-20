// Post-create indexing for a memory row, shared by every write path. Three write
// paths (memory_write, closeout's episode, closeout's keyMemories) each need the
// same follow-up after the row is created: compute + store the embedding, and
// build entity→memory mention edges. The keyMemories path additionally builds
// memory→memory similar edges. They had drifted into three near-copies with
// subtly different error handling; this is the one path they now share.
//
// Each arm swallows its own failure independently: the memory row is already
// saved, and the nightly sweeps (embedding + mentions + similarity) are the
// safety net, so one failing arm must never block the others or the caller.

import prisma from "../db.js";
import { embedText, writeEmbedding } from "./embed.js";
import { sweepMemoryMentions } from "./entity-mentions.js";
import { errMessage } from "./err.js";
import { findSimilarMemories } from "./memory-similarity.js";

export interface IndexResult {
  /** True if an embedding was computed and written. */
  embedded: boolean;
  /** Number of memory→memory similar edges created (0 unless withSimilarEdges). */
  edgesCreated: number;
}

export async function indexNewMemory(
  memoryId: string,
  embedInput: string,
  opts: { withSimilarEdges?: boolean; logTag?: string } = {},
): Promise<IndexResult> {
  const tag = opts.logTag ?? "index";

  // 1. Embedding. embedText already catches network/shape errors and returns
  //    null; the try also guards the writeEmbedding DB write. A null/failed embed
  //    leaves the row for the nightly embedding sweep.
  let emb: number[] | null = null;
  try {
    emb = await embedText(embedInput);
    if (emb) await writeEmbedding("memories", memoryId, emb);
  } catch (e: unknown) {
    console.warn(`[${tag}] embedding failed (sweep will retry): ${errMessage(e)}`);
  }

  // 2. Entity→memory mention edges. Independent of the embed — its own catch, so
  //    an embed failure never blocks mentions and vice-versa.
  try {
    await sweepMemoryMentions(memoryId);
  } catch (e: unknown) {
    console.warn(`[${tag}] mention sweep failed: ${errMessage(e)}`);
  }

  // 3. Memory→memory similar edges (closeout's keyMemories only). Needs the
  //    embedding; reuses findSimilarMemories — the same cosine query the nightly
  //    similarity sweep uses, so the two edge-creation paths can't drift.
  let edgesCreated = 0;
  if (opts.withSimilarEdges && emb) {
    const sims = await findSimilarMemories(emb, memoryId);
    for (const s of sims) {
      await prisma.link.create({
        data: {
          fromType: "memory",
          fromId: memoryId,
          toType: "memory",
          toId: s.id,
          relationType: "similar",
          confidence: s.confidence,
          note: `auto-linked at closeout (cosine sim ${s.confidence.toFixed(2)})`,
        },
      });
      edgesCreated++;
    }
  }

  return { embedded: !!emb, edgesCreated };
}
