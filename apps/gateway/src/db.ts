import { PrismaClient } from "@prisma/client";

// Note on embedding columns: several tables (memories / topics / core_profile /
// observations) have a vector(1536) column in the DB that is intentionally NOT
// declared in schema.prisma. Prisma can't deserialize pgvector, and the
// omit/select config doesn't cover Unsupported types either. So Prisma stays
// ignorant — findMany/findFirst skip the column entirely — and embedding
// read/write goes through $queryRaw in the retrieval and backfill code paths.
const prisma = new PrismaClient();

export default prisma;
