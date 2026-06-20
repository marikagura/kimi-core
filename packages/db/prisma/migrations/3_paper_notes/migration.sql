-- Paper extension table — opt-in academic note store (paper_notes), independent
-- of the memory engine. Created here because Prisma uses a single schema file;
-- disabling the paper extension just leaves this table unused (no FKs into it).

CREATE TABLE "paper_notes" (
    "id" TEXT NOT NULL,
    "externalId" TEXT,
    "title" TEXT NOT NULL,
    "journal" TEXT,
    "authors" TEXT,
    "url" TEXT,
    "publishedAt" TIMESTAMP(3),
    "knowledge" TEXT NOT NULL,
    "relevance" TEXT,
    "axis" TEXT,
    "hasFullText" BOOLEAN NOT NULL DEFAULT false,
    "importance" INTEGER NOT NULL DEFAULT 3,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "embeddingAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "paper_notes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "paper_notes_externalId_key" ON "paper_notes"("externalId");

-- pgvector column for future semantic search — Unsupported in Prisma, added by raw
-- SQL like memories.embedding. The `vector` extension is created in 0_init.
ALTER TABLE "paper_notes" ADD COLUMN "embedding" vector(1536);
