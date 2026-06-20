import { z } from "zod";
import { firstJsonObject } from "./json-extract.js";

// Runtime schemas for the JSON shapes intel.ts parses out of LLM responses. The
// system's stance is "don't trust the AI's output", but the digest / score parsing
// validated shape with scattered hand-written `typeof` guards. These schemas pull
// that contract into one place — they mirror the old guards EXACTLY, not more
// strictly:
//   - no value-range bounds (the originals only checked `typeof === "number"`, never
//     that valence ∈ [-1, 1]); range-checking would reject outputs the old code
//     accepted, so it is deliberately left out.
//   - per-field hardness matches the originals: a field is "hard" (its absence/
//     malformation fails the whole object, triggering the caller's existing retry/
//     skip) or "soft" (it degrades to a default without rejecting the object). Soft
//     fields use `.catch(...)` so one bad field never connects-out to drop the rest.

// scanDialogueDigests output.
//   summary  — HARD: mirrors `if (p.summary)` (missing/empty → retry, then skip).
//   valence  — soft: mirrors `typeof p.valence === "number" ? p.valence : null`.
//   arousal  — soft: same.
//   topic    — soft: mirrors `p.x && typeof p.x === "string"`.
export const DigestSchema = z.object({
  summary: z.string().min(1),
  valence: z.number().nullable().catch(null),
  arousal: z.number().nullable().catch(null),
  suggested_topic_slug: z.string().nullable().catch(null),
});
export type Digest = z.infer<typeof DigestSchema>;

// Session self-score.
//   valence + arousal — HARD: mirrors `typeof v === "number" && typeof a === "number"`
//     (either missing/non-number → the whole score is dropped, i.e. parse → null).
//   note — soft: mirrors `score.note ?? ""`.
export const SessionScoreSchema = z.object({
  valence: z.number(),
  arousal: z.number(),
  note: z.string().catch(""),
});
export type SessionScore = z.infer<typeof SessionScoreSchema>;

// Pull the first JSON object out of a raw response and validate it as a digest.
// Returns null on no-JSON or a hard-field failure — the caller's loop retries then
// skips, exactly as before.
export function parseDigest(raw: string): Digest | null {
  const r = DigestSchema.safeParse(firstJsonObject(raw));
  return r.success ? r.data : null;
}

// The main extraction call wraps the score as `{ sessionScore: {...} }`; the
// score-only retry returns it bare. Unwrap, then validate. Returns null on failure;
// the caller decides the fallback (a score-only retry, or skipping the write).
export function parseSessionScore(raw: string): SessionScore | null {
  const obj = firstJsonObject(raw) as Record<string, unknown> | null;
  if (!obj) return null;
  const r = SessionScoreSchema.safeParse(obj.sessionScore ?? obj);
  return r.success ? r.data : null;
}
