-- Store extension table — opt-in structured surface store (store_rows) for the
-- kimi-room / kimi-manor dashboards (calendar / sleep / keepsakes / …), independent
-- of the memory engine. Created here because Prisma uses a single schema file;
-- disabling the store extension just leaves this table unused (no FKs into it).
-- createdAt / updatedAt are written explicitly by the adapter layer (no DB
-- default), so timestamps survive an export→import round-trip unchanged.

CREATE TABLE "store_rows" (
    "id" TEXT NOT NULL,
    "collection" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "store_rows_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "store_rows_collection_idx" ON "store_rows"("collection");
