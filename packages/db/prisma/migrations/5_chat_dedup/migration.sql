-- Chat-sync idempotency: a composite unique on (eventType, dedupeKey) makes a
-- client-supplied idempotency key reject a retried duplicate. Postgres treats NULL
-- as distinct in a unique index, so the many rows that carry no dedupeKey (the
-- default) stay unconstrained — only non-null (eventType, dedupeKey) pairs are
-- forced unique. POST /chat and chat_write catch the unique-violation and return
-- the already-stored row instead of inserting a second copy.

CREATE UNIQUE INDEX "events_eventType_dedupeKey_key" ON "events"("eventType", "dedupeKey");
