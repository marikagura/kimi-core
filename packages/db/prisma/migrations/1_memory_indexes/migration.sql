-- Add btree indexes to the memories table for the hot context-build / cron /
-- derive queries (before this, only the HNSW vector index existed, so every
-- non-vector filter/sort was a sequential scan).

-- CreateIndex
CREATE INDEX "memories_isActive_memoryType_idx" ON "memories"("isActive", "memoryType");

-- CreateIndex
CREATE INDEX "memories_memoryType_sourceType_experiencer_idx" ON "memories"("memoryType", "sourceType", "experiencer");

-- CreateIndex
CREATE INDEX "memories_concernKey_idx" ON "memories"("concernKey");

-- CreateIndex
CREATE INDEX "memories_createdAt_idx" ON "memories"("createdAt");
