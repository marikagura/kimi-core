# Roadmap

> 中文版: [ROADMAP.md](./ROADMAP.md)

Named honestly — what's done, what's not — rather than implied. This is a **personal, single-user (1:1) agent memory OS** — scoped to one human and one AI, not multi-user / production scale.

## Already in core (landed, tested, documented)

- **Hybrid retrieval** — dense (pgvector) + lexical (trigram / optional BM25) + entity graph walk, four-signal weighting + an optional cross-encoder rerank (privacy-gated).
- **self-drive + concern engine** — the four SEEKING shapes, **config-driven dimensions** (you define your own, see [docs/DRIVES.en.md](./docs/DRIVES.en.md)), and concern open / decay / recurrence / grounding.
- **Reproducible eval** — hit@5 / hit@10 · MRR · nDCG@10 · set-recall@10 · expectNone control · component / rerank A/B · a trend Event per run (`npm run eval` / `npm run eval:history`).
- **Autonomous wake daemon** — cron wake → drive / concern / persona → action selection (DO_NOTHING is one option) → dispatch, with a HITL propose / auto knob (`daemon.ts` + `intel.ts`; argument in [docs/AUTONOMY.en.md](./docs/AUTONOMY.en.md)).
- **Conversational onboarding** — `npm run init` is a dialogue: it interviews you and grows the persona / AGENTS.md relationship layer in your own words (it never writes persona content for you); with a key it adds an adaptive follow-up, keyless it's a guided dialogue (`scripts/init.ts` + `persona-build.ts`).
- **Adversarial self-audit harness** — `npm run scrub` mechanical de-id gate + [docs/SELF-AUDIT.en.md](./docs/SELF-AUDIT.en.md) behavioral audit.
- **Reference delivery providers** — a configurable Notifier (console / webhook) + search provider (http), env-driven and off by default (`lib/providers.ts`, wired into the daemon).
- Event-sourcing + append-only + human curation; CI (tsc + test + scrub).

## Not done yet

- **SQLite lite backend.** The engine runs on Postgres + pgvector today (one `DATABASE_URL`). A storage / retrieval-backend abstraction plus SQLite (sqlite-vec vectors + FTS5 lexical) would give a zero-dependency "lite" mode: `npm install` and go — no Docker, no server — which fits the single-user personal case. The retrieval layer's raw SQL (pgvector `<=>`, pg_trgm, pgroonga) is Postgres-bound, so SQLite means a second retrieval implementation — a multi-step effort. **This is the next focus.**
- **More delivery / search integrations.** Reference implementations ship (a webhook notifier, an http search provider); more ready-to-use backends (Slack / Discord / ntfy presets, specific search-API adapters) are welcome. EXPLORE's suggestion content stays empty by design (the persona layer).

## Non-goals

- **Multi-user / production scale — out of scope.** This is a single-user (1:1) memory OS. Retrieval scores every row per query, which is plenty at one person's lifetime scale; the ANN candidate-pool path (HNSW etc.) is intentionally not built. Serving many users is a different project.

## v2 (next)

- **SQLite lite** — the zero-dependency personal mode (the next focus; multi-step).
- Publish the eval numbers across versions (regression trend).
- More ready-to-use delivery / search backend presets.
