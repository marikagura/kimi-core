-- Weekly-arc cross-process dedup. writeArcMemory (extensions/weekly-arc) does a
-- findFirst-then-create keyed on title (= "weekly arc <weekKey>"), a TOCTOU race two
-- daemon processes — or a manual `npm run weekly:arc` overlapping the cron — can both
-- pass, writing two importance-4 SHARED EPISODE arcs for the same week. The code
-- already catches P2002 and treats it as a dedup; this partial unique is what makes
-- that real. Scoped to active arc rows (title LIKE 'weekly arc %' AND "isActive") so
-- it matches the findFirst({ isActive: true }) lookup and never touches other
-- memories or historical deactivated arcs.
--
-- Collapse any pre-existing active duplicates first (keep the lowest physical row per
-- title), or CREATE UNIQUE INDEX would fail on them. Normally a no-op (the in-process
-- lock + findFirst make a real duplicate rare).

DELETE FROM "memories" a
USING "memories" b
WHERE a.ctid > b.ctid
  AND a.title = b.title
  AND a."isActive" = true AND b."isActive" = true
  AND a.title LIKE 'weekly arc %';

CREATE UNIQUE INDEX "memories_weekly_arc_title_key"
  ON "memories"(title)
  WHERE title LIKE 'weekly arc %' AND "isActive";
