-- Make edge idempotency structural instead of timing-dependent. The Link writers
-- (entity-mentions, memory-index, memory-similarity) enforced uniqueness with a
-- SELECT-then-INSERT, which a concurrent indexer + nightly sweep can race into a
-- duplicate edge — inflating the entity-hit array_agg in retrieval and the
-- graph-walk fan-out. A unique on the natural key closes the race.
--
-- A DB that already raced has duplicate rows, and CREATE UNIQUE INDEX would fail on
-- them — so collapse duplicates first, keeping the lowest id per natural key.

DELETE FROM "links" a
USING "links" b
WHERE a.ctid > b.ctid
  AND a."fromType" = b."fromType"
  AND a."fromId" = b."fromId"
  AND a."toType" = b."toType"
  AND a."toId" = b."toId"
  AND a."relationType" = b."relationType";

CREATE UNIQUE INDEX "links_fromType_fromId_toType_toId_relationType_key"
  ON "links"("fromType", "fromId", "toType", "toId", "relationType");
