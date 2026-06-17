-- Runs automatically on a fresh empty volume. Only creates extensions; tables /
-- vector columns / indexes are left to Prisma migrations, so responsibilities
-- stay separated and don't collide.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Note: the CJK BM25 lexical-retrieval leg uses pgroonga. The official
-- pgvector/pgvector image does not bundle it; for CJK lexical recall, switch to
-- an image with pgroonga or build the extension yourself. Without it, retrieval
-- automatically falls back to pgvector (semantic) + pg_trgm (fuzzy) and won't break.
