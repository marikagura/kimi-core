# Roadmap

> 中文版: [ROADMAP.md](./ROADMAP.md)

Named honestly — what's done, and what's not — rather than implied.

## Already in core (landed, tested, documented)

- **Hybrid retrieval** — dense (pgvector) + lexical (trigram / optional BM25) + entity graph walk, four-signal weighting + an optional cross-encoder rerank (privacy-gated).
- **self-drive + concern engine** — the four SEEKING shapes, **config-driven dimensions** (you define your own, see [docs/DRIVES.en.md](./docs/DRIVES.en.md)), and concern open / decay / recurrence / grounding.
- **Reproducible eval** — hit@5 / hit@10 · MRR · nDCG@10 · set-recall@10 · expectNone negative control · component / rerank A/B · a trend Event per run (`npm run eval` / `npm run eval:history`).
- **Autonomous wake daemon** — cron wake → drive / concern / persona → action selection (DO_NOTHING is one option) → dispatch, with a HITL propose / auto knob (`daemon.ts` + `intel.ts`; argument in [docs/AUTONOMY.en.md](./docs/AUTONOMY.en.md)).
- **Adversarial self-audit harness** — `npm run scrub` mechanical de-id gate + [docs/SELF-AUDIT.en.md](./docs/SELF-AUDIT.en.md) behavioral audit.
- **Reference delivery providers** — a configurable Notifier (console / webhook) + search provider (http), env-driven and off by default (`lib/providers.ts`, wired into the daemon).
- Event-sourcing + append-only + human curation; CI (tsc + test + scrub).

## Not done yet (deliberately out, or unfinished)

- **SQLite storage backend.** The engine runs on Postgres + pgvector today (one `DATABASE_URL`, local via Docker or any remote). A repository-interface abstraction plus a SQLite + sqlite-vec backend would give a zero-dependency "lite" mode (no Docker, no server). The reranker is already plugin-shaped; storage is not yet — the next pluggable boundary.
- **Retrieval indexing at scale.** Retrieval currently scores every active row per query (fine at single-user scale, noted in `retrieval.ts`). Past ~10k rows it should switch to a candidate-pool CTE (HNSW + trigram GIN) before scoring — the ANN path isn't wired yet.
- **More delivery / search integrations.** Reference implementations now ship (a webhook notifier, an http search provider); more ready-to-use concrete backends (Slack / Discord / ntfy presets, specific search-API adapters) are still welcome. EXPLORE's suggestion content stays empty by design (the persona layer).
- **Conversational onboarding.** `npm run init` is a CLI questionnaire today; a chat-style persona builder (the way a persona is actually grown, not filled in a form) is a v2.

## v2

- A conversational persona builder, replacing the CLI questionnaire.
- Pluggable storage (including a SQLite "lite" mode).
- Retrieval at scale (an ANN candidate pool), and publishing the eval numbers across versions.
- More ready-to-use delivery / search backend presets (Slack / Discord / ntfy / mainstream search APIs).
