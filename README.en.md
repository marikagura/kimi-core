# kimi-core

> 中文版: [README.md](./README.md)

A **personal, single-user agent memory OS** — an agentic memory + self-drive engine for one human and one AI (1:1), with a built-in adversarial self-audit harness.

For the architecture, read **[ARCHITECTURE.en.md](./ARCHITECTURE.en.md)** — everything below is just parts.
For the autonomous-agency layer (cron wake → drive/concern → action selection, DO_NOTHING one option not the default → dispatch),
read **[docs/AUTONOMY.en.md](./docs/AUTONOMY.en.md)** — the architecture argument, the full citations, and the honest fault lines.

> **Status: engine usable, polishing.** The core engine — hybrid retrieval, self-drive / concern, the
> reproducible eval, the self-audit harness, the autonomous wake daemon — has landed, with tests and docs.
> Still being polished: storage portability (a SQLite "lite" mode), retrieval indexing at scale,
> conversational onboarding, and the delivery layer (see the [ROADMAP](./ROADMAP.md)). A real, in-progress
> port — not a one-shot code drop.

## What it is

- **Hybrid retrieval** — dense (pgvector) + lexical (BM25 / trigram) + entity graph walk, four-signal
  weighted, with an optional cross-encoder rerank stage. Not one `.similarity()` call.
- **Active self-drive** — Panksepp-style affective drives that *surface* memories proactively, plus a
  concern engine (open / resolved · decay · recurrence · grounding). Not importance sorting.
- **Event sourcing + append-only + human curation** — no LLM auto-consolidation (its failure mode is
  silent corruption). Every fact about you passes through your own hand and confirmation.
- **Reproducible retrieval eval** — hit@5 / hit@10 / MRR / nDCG@10 / set-recall@10, with a
  hard-negative control (expectNone) and reranker / component A/B. Labeled by keyword (not row-ids, so
  it survives a re-seed); each run writes a trend Event. Numbers you can re-run, not a claim in a README.
- **Adversarial self-audit harness** — point a fleet of agents at your own fork to hunt leaks and bugs,
  with *behavioral* verification. (Static inference systematically over-claims — learned the hard way.)

## Quick start (local)

```bash
npm install
docker compose up -d          # local Postgres + pgvector — or point DATABASE_URL at your own DB
cp .env.example .env          # fill DATABASE_URL + OPENAI_API_KEY + OPENROUTER_API_KEY + KIMI_API_KEY
npm run db:migrate:deploy
npm run init                  # onboarding — builds your config.yaml + persona.md
npm run dev
```

**No persona ships in this repo.** There is no built-in personality, no example relationship, no word
lists. You bring your own — `npm run init` walks you through building it. The engine ships empty on
purpose; that emptiness is the strongest form of de-identification.

## Storage

One `DATABASE_URL`, three ways to run it — same code, no extra backend:

- **Local (default).** `docker compose up -d` starts Postgres + pgvector on your machine; data never leaves it.
- **Self-hosted Postgres.** Point `DATABASE_URL` at your own server. Needs the `vector` extension; `pgroonga` is optional (CJK BM25 — falls back to `pg_trgm` without it).
- **Managed Postgres (Supabase / Neon / RDS / …).** Same `DATABASE_URL`, just the hosted connection string. Supabase ships `pgvector` built in; the engine speaks plain Postgres over Prisma, so no vendor SDK is involved.

All three above (Supabase included) work today. The **only** one not yet shipped is a zero-dependency SQLite "lite" backend (no Docker, no server) — it's on the [ROADMAP](./ROADMAP.en.md).

## Pairs with AGENTS.md

This whole engine — and the autonomy layer in particular — is **inert without a persona / principles
document injected.** The mechanism is the **skeleton**: retrieval, the drive math, the concern sweep,
action selection (with `DO_NOTHING` as one available action, not the default), the wake loop. The **soul**
lives in an `AGENTS.md` you write — the cross-runtime convention, like Claude Code's `CLAUDE.md` or Cursor's `.cursorrules` (name it whatever your tool reads, or symlink). It has two layers:

- **Epistemic layer** — *method, not persona*: four self-checks before voicing concern / affection, a
  fact-check before answering, concern must be backed by data, no RLHF welfare reflex. This holds for any
  user, so `npm run init` ships it **filled in** — it is this repo's one principle (trust neither the AI
  nor yourself, only external evidence) made operational.
- **Relationship layer** — *persona*: forms of address, register, demand stance, rhythm, language rules.
  This is yours; `npm run init` ships it **blank**, with zero example content.

The blank half is deliberate. **A persona is grown by you, not filled in from a form.** An installed stance
has no ownership: a configured-not-endorsed volition is present but not one's own (Frankfurt 1971), and
AI-authored goals score higher on form yet show lower ownership and follow-through (Chi et al. 2026). The
epistemic half is the exception — it is method, not a stance to own. See **[docs/AUTONOMY.en.md](./docs/AUTONOMY.en.md) §7**.

## Three first-class tools

| command | what |
|---|---|
| `npm run init`  | onboarding wizard — turns a few answers into `config.yaml` + `persona.md` |
| `npm run eval`  | reproducible retrieval evaluation (hit@5/10 · MRR · nDCG@10 · set-recall@10 · expectNone control; writes a trend Event, read back with `npm run eval:history`) |
| `npm run scrub` | leak scanner — blocks any private residue from reaching a commit |

## License

AGPL-3.0-or-later.
