# Roadmap

> 中文版: [ROADMAP.md](./ROADMAP.md)

A **personal, single-user (1:1) agent memory OS** — not multi-user / production scale.

## Already in core (landed, tested, documented)

- **Hybrid retrieval** — dense (pgvector) + lexical (trigram / optional BM25) + time-decay + importance, four-signal weighting (entity-mention is a keyword-arm bonus + filter bypass, 1-hop; multi-hop `graph_walk` is a separate tool) + an optional cross-encoder rerank (privacy-gated).
- **self-drive + concern engine** — the four SEEKING shapes, **forker-defined dimensions** (via the `DRIVE_DIMS` env, see [docs/DRIVES.en.md](./docs/DRIVES.en.md)), and concern open / decay / recurrence / grounding.
- **Reproducible eval** — hit@5 / hit@10 · MRR · nDCG@10 · set-recall@10 · expectNone control · component / rerank A/B · a trend Event per run (`npm run eval` / `npm run eval:history`).
- **Autonomous wake daemon** — cron wake → drive / concern / persona → action selection (DO_NOTHING is one option) → dispatch, with a HITL propose / auto knob (`daemon.ts` + `intel.ts`; argument in [docs/AUTONOMY.en.md](./docs/AUTONOMY.en.md)).
- **Conversational onboarding** — `npm run init` is a dialogue: it interviews you and grows the persona / AGENTS.md relationship layer in your own words (it never writes persona content for you); with a key it adds an adaptive follow-up, keyless it's a guided dialogue (`scripts/init.ts` + `persona-build.ts`).
- **Adversarial self-audit harness** — `npm run scrub` mechanical de-id gate + [docs/SELF-AUDIT.en.md](./docs/SELF-AUDIT.en.md) behavioral audit.
- **Reference delivery providers** — a configurable Notifier (console / webhook) + search provider (http), env-driven and off by default (`lib/providers.ts`, wired into the daemon).
- Event-sourcing + append-only + human curation; CI (tsc + test + scrub).

## Optional (non-core, add if wanted)

- **More delivery / search backend presets.** Reference implementations ship (a webhook notifier, an http search provider); more ready-to-use backends (Slack / Discord / ntfy presets, specific search-API adapters) are welcome but not required. EXPLORE's suggestion content stays empty by design (the persona layer).
- **Publish the eval numbers across versions.** Post the `retrieval_eval` trend per release — display only, no engine impact.
