-- Per-row embedding model identity. The only model-change guard was the dimension
-- check, which can't see a SAME-dimension model swap (e.g. ada-002 → 3-small, both
-- 1536-dim, or OpenAI → a 1536-dim local model): different vector spaces, so cosine
-- similarity across them is meaningless and retrieval silently returns wrong results.
-- writeEmbedding now stamps the producing model here, and STALE_EMBEDDING_WHERE
-- re-embeds any row whose stamped model differs from the current EMBED_MODEL.
--
-- Nullable + no backfill on purpose: existing rows pre-date the column and their
-- producing model is unknown, so they stay NULL and are NOT force-re-embedded (the
-- predicate only flags a row whose stamped model is non-null AND differs). This
-- catches every swap going forward without a surprise full re-embed on deploy.

ALTER TABLE "memories" ADD COLUMN "embedModel" TEXT;
ALTER TABLE "observations" ADD COLUMN "embedModel" TEXT;
ALTER TABLE "core_profile" ADD COLUMN "embedModel" TEXT;
