// OpenAI embeddings wrapper (model via EMBED_MODEL; no built-in default). Returns
// null on any failure — call sites gracefully fall back to keyword/trigram search.
//
// 1536-dim. Input truncated to 8k chars (~2k tok) as a safety cap — longer
// inputs cost more without proportional quality gain for the memory/digest/
// profile use case.

import { fetchWithRetry } from "../fetch-retry.js";
import { embedModelOrNull } from "./models.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY;

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
    return emb;
  } catch (err: any) {
    console.error("[embed] failed:", err?.message || err);
    return null;
  }
}

// Format a Float[] as a pgvector literal string for raw SQL.
// vector(1536) accepts '[0.1,0.2,...]'.
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
