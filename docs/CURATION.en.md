# Manual curation

This engine is append-only and **never auto-consolidates memories** (see ARCHITECTURE / EPISTEMIC: trust neither the AI nor yourself — only external evidence). That design has a cost: **the store grows until you curate it by hand.** This is intentional — every fact about you passes through your confirmation — but it means curation is a real, recurring operation, not an optional one.

## What to curate

- **High-importance core** (`importance` 4-5): the identity / commitment / boundary memories. Review them periodically — merge duplicates, close superseded ones, fix drift. They carry the most weight in every context build, so stale ones cost the most.
- **Duplicates / near-duplicates**: append-only means the same fact can land twice.
- **Superseded / stale**: facts that changed — close the old one.
- **OPEN concerns that have actually resolved** but were never closed.

## How to do it (no dashboard required)

The engine ships MCP tools — any MCP client (or your own UI) can drive them:

- `memory_read` (sorted by importance) / `memory_search` — see what's in the store.
- `memory_close` (by id, or titleMatch) — soft-delete (`isActive=false`; nothing is hard-deleted, so it's reversible).
- `memory_reopen` — bring a wrongly-closed concern back.
- `graph_walk` — see what a memory connects to before you close it.

Or query the database directly (Postgres, `memories` table). The repo's own backstage UI is a separate project; **the tools are the portable interface.**

## When (the engine nudges you)

The daily intel run emits a `curation:` line (active count, high-importance pool, open-concern count) and raises a flag when the high-importance pool crosses a threshold (`CURATION_REVIEW_THRESHOLD`, default 30). Wire it into your notifier, or just read the intel summary.

The point: you don't have to remember to curate — the engine reminds you.
