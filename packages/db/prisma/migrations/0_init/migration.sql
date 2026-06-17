-- kimi-core baseline migration (0_init)
-- Extensions first; HNSW indexes appended (Prisma can't emit from Unsupported vector).

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PendingType" AS ENUM ('MEMORY_CANDIDATE', 'TOPIC_LINK', 'DIGEST', 'DIARY_NOTE', 'QUEUE_MESSAGE');

-- CreateEnum
CREATE TYPE "PendingStatus" AS ENUM ('OPEN', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "Mode" AS ENUM ('WORK', 'LOVE', 'MIXED');

-- CreateEnum
CREATE TYPE "Verbosity" AS ENUM ('SHORT', 'MEDIUM', 'LONG');

-- CreateEnum
CREATE TYPE "Initiative" AS ENUM ('PASSIVE', 'LOW', 'ACTIVE');

-- CreateEnum
CREATE TYPE "Comfort" AS ENUM ('EXPLAIN', 'COMPANION', 'NO_EMPTY_COMFORT');

-- CreateEnum
CREATE TYPE "StateType" AS ENUM ('HEALTH', 'MOOD', 'PROJECT', 'STRESS', 'RELATIONSHIP', 'SCHEDULE', 'SELF_CONCERN', 'SELF_DRIVE');

-- CreateEnum
CREATE TYPE "TopicStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "Domain" AS ENUM ('WORK', 'LOVE', 'SYSTEM', 'RESEARCH');

-- CreateEnum
CREATE TYPE "DecisionStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'DRAFT');

-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('PERSON', 'TOOL', 'PLATFORM', 'PROJECT', 'CONCEPT');

-- CreateEnum
CREATE TYPE "EntityStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "MemoryType" AS ENUM ('CORE', 'STATE', 'EPISODE', 'PREFERENCE', 'BOUNDARY', 'RESTRICTED', 'REGISTER', 'SELF_SCORE');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('CHAT', 'WEB', 'REPO', 'EVENT', 'MANUAL');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('CHAT', 'APP_OPEN', 'MANUAL_NOTE', 'SYSTEM', 'DREAM', 'SCORE_FEEDBACK', 'THOUGHT_HIT', 'THOUGHT_RESOLVED');

-- CreateEnum
CREATE TYPE "Experiencer" AS ENUM ('USER', 'SELF', 'SHARED');

-- CreateEnum
CREATE TYPE "Resolution" AS ENUM ('OPEN', 'EASING', 'SUPPRESSED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ConcernGrounding" AS ENUM ('DATA', 'EVIDENCE', 'SUBJECTIVE');

-- CreateEnum
-- (OAuthStatus enum removed: no OAuth surface in the open-source engine)

-- CreateTable
CREATE TABLE "core_profile" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "importance" INTEGER NOT NULL DEFAULT 3,
    "source" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "embedding" vector(1536),
    "embeddingAt" TIMESTAMP(3),

    CONSTRAINT "core_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "register_profiles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "Mode" NOT NULL DEFAULT 'MIXED',
    "toneKeywords" TEXT,
    "preferredAddressing" TEXT,
    "forbiddenPhrases" TEXT,
    "preferredPhrases" TEXT,
    "verbosityStyle" "Verbosity" NOT NULL DEFAULT 'MEDIUM',
    "initiativeStyle" "Initiative" NOT NULL DEFAULT 'LOW',
    "comfortStyle" "Comfort" NOT NULL DEFAULT 'EXPLAIN',
    "exampleSnippets" TEXT,
    "triggerConditions" JSONB,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "register_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "active_state" (
    "id" TEXT NOT NULL,
    "stateType" "StateType" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "content" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endAt" TIMESTAMP(3),
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "source" TEXT,
    "sourceKey" TEXT,
    "sourceMemoryId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "active_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topics" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT,
    "status" "TopicStatus" NOT NULL DEFAULT 'ACTIVE',
    "domain" "Domain" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "embedding" vector(1536),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decisions" (
    "id" TEXT NOT NULL,
    "topicId" TEXT,
    "title" TEXT NOT NULL,
    "decisionText" TEXT NOT NULL,
    "rationale" TEXT,
    "status" "DecisionStatus" NOT NULL DEFAULT 'ACTIVE',
    "supersedesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entities" (
    "id" TEXT NOT NULL,
    "entityType" "EntityType" NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT,
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memories" (
    "id" TEXT NOT NULL,
    "memoryType" "MemoryType" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "content" TEXT NOT NULL,
    "importance" INTEGER NOT NULL DEFAULT 3,
    "emotionalWeight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stabilityScore" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "sourceType" "SourceType" NOT NULL,
    "sourceRefId" TEXT,
    "topicId" TEXT,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "embedding" vector(1536),
    "embeddingAt" TIMESTAMP(3),
    "valence" DOUBLE PRECISION,
    "arousal" DOUBLE PRECISION,
    "experiencer" "Experiencer" NOT NULL DEFAULT 'USER',
    "resolution" "Resolution" NOT NULL DEFAULT 'OPEN',
    "grounding" "ConcernGrounding",
    "concernKey" TEXT,
    "eventIdStart" TEXT,
    "eventIdEnd" TEXT,
    "digestTimeStart" TIMESTAMP(3),
    "digestTimeEnd" TIMESTAMP(3),
    "activationCount" INTEGER NOT NULL DEFAULT 0,
    "authorModel" TEXT,
    "bondClosure" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "eventType" "EventType" NOT NULL,
    "value" TEXT,
    "source" TEXT,
    "startTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endTime" TIMESTAMP(3),
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "observations" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "importance" INTEGER NOT NULL DEFAULT 3,
    "author" TEXT,
    "threadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "embedding" vector(1536),
    "embeddingAt" TIMESTAMP(3),

    CONSTRAINT "observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webauthn_credentials" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "deviceLabel" TEXT,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "deviceType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "webauthn_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pwa_kv" (
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pwa_kv_pkey" PRIMARY KEY ("namespace","key")
);

-- CreateTable
-- (oauth_credentials table removed: no OAuth surface in the open-source engine)

-- CreateTable
CREATE TABLE "links" (
    "id" TEXT NOT NULL,
    "fromType" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toType" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "relationType" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_items" (
    "id" TEXT NOT NULL,
    "pendingType" "PendingType" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "proposedAction" TEXT,
    "sourceRefType" TEXT,
    "sourceRefId" TEXT,
    "topicId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" "PendingStatus" NOT NULL DEFAULT 'OPEN',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "embedding" vector(1536),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "pending_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "core_profile_key_key" ON "core_profile"("key");

-- CreateIndex
CREATE UNIQUE INDEX "register_profiles_name_key" ON "register_profiles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "topics_slug_key" ON "topics"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "entities_name_key" ON "entities"("name");

-- CreateIndex
CREATE INDEX "events_eventType_source_createdAt_idx" ON "events"("eventType", "source", "createdAt");

-- CreateIndex
CREATE INDEX "events_createdAt_idx" ON "events"("createdAt");

-- CreateIndex
CREATE INDEX "events_dedupeKey_idx" ON "events"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "observations_key_key" ON "observations"("key");

-- CreateIndex
CREATE UNIQUE INDEX "webauthn_credentials_credentialId_key" ON "webauthn_credentials"("credentialId");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_codes_codeHash_key" ON "recovery_codes"("codeHash");

-- CreateIndex
CREATE INDEX "pwa_kv_namespace_updatedAt_idx" ON "pwa_kv"("namespace", "updatedAt");

-- CreateIndex
-- (oauth_credentials index removed)

-- CreateIndex
CREATE INDEX "links_fromType_fromId_relationType_idx" ON "links"("fromType", "fromId", "relationType");

-- CreateIndex
CREATE INDEX "links_toType_toId_idx" ON "links"("toType", "toId");

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "decisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_items" ADD CONSTRAINT "pending_items_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- HNSW cosine indexes over embeddings (m=16, ef_construction=64)
CREATE INDEX IF NOT EXISTS memories_embedding_hnsw ON "memories" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS topics_embedding_hnsw ON "topics" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS observations_embedding_hnsw ON "observations" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS core_profile_embedding_hnsw ON "core_profile" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS pending_items_embedding_hnsw ON "pending_items" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);
