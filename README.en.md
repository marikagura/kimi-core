# kimi-core

> 中文版: [README.md](./README.md)

A **personal, single-user agent memory OS** — an agentic memory + self-drive engine for one human and one AI (1:1), with a built-in adversarial self-audit harness.

For the architecture, read **[ARCHITECTURE.en.md](./ARCHITECTURE.en.md)** — everything below is just parts.
For the autonomous-agency layer (cron wake → drive/concern → action selection, DO_NOTHING one option not the default → dispatch),
read **[docs/AUTONOMY.en.md](./docs/AUTONOMY.en.md)** — the architecture argument, the full citations, and the honest fault lines.
The engineering pitfalls we hit building this are collected in **[docs/PATTERNS.en.md](./docs/PATTERNS.en.md)** — caching, cold-start, Prisma/pgvector, retrieval, agent safety, retry, time, and more (sixteen areas), with the silent and domain-specific ones up front and the table-stakes hygiene in an appendix. Worth a read before you fork.
For the epistemic layer (retrieval-first / no hallucinated recall / attribution checks / symmetric verification / concern self-checks), see **[docs/EPISTEMIC.en.md](./docs/EPISTEMIC.en.md)** — the operational manual for the AGENTS.md epistemic layer.

> **Status: engine complete, with tests and docs.** hybrid retrieval, self-drive / concern, the
> reproducible eval, conversational onboarding, reference delivery providers, and the adversarial self-audit
> harness have all landed (tsc + test + scrub run in CI). The scope is **personal 1:1** — multi-user /
> production and a SQLite "lite" mode are explicit **non-goals** (see the [ROADMAP](./ROADMAP.en.md)). The
> autonomous wake daemon is wired and unit-tested; actually running it needs a Claude subscription token +
> a two-process setup (see "Running the autonomous daemon" below).

## What it is

- **Hybrid retrieval** — dense (pgvector) + lexical (BM25 / trigram) + time-decay + importance, four-signal
  weighted (entity-mention is a keyword-arm bonus + filter bypass, 1-hop; multi-hop `graph_walk` is a separate
  tool, not part of the ranked score), with an optional cross-encoder rerank stage.
- **Active self-drive** — Panksepp-style affective drives that *surface* memories proactively, plus a
  concern engine (open / resolved · decay · recurrence · grounding).
- **Event sourcing + append-only + human curation** — no LLM auto-consolidation (its failure mode is
  silent corruption). Every fact about you passes through your own hand and confirmation. This is a necessary, recurring operation (not optional) — how to do it: [docs/CURATION.md](docs/CURATION.md).
- **Reproducible retrieval eval** — hit@5 / hit@10 / MRR / nDCG@10 / set-recall@10, with a
  hard-negative control (expectNone) and reranker / component A/B. Labeled by keyword (not row-ids, so
  it survives a re-seed); each run writes a trend Event.
- **Adversarial self-audit harness** — point a set of agents at your own fork to find leaks and bugs,
  with *behavioral* verification. (Static inference systematically over-claims — learned the hard way.)

## What it does (a concrete example)

(A fictional example user, not any real person.)

Three days ago you told it you were rushing a project called Helios, due Friday. Today, on a scheduled wake, the self-drive "companionship" dimension rises (it's been a while) and the concern engine flags the approaching deadline — so what it surfaces isn't a generic hello, it's "Helios is due Friday — where did yesterday's demo get stuck?" Because it **retrieved** that memory, and the concern is **grounded in what you actually said**.

Three points from this example: memory is retrievable, concern is data-backed, and initiative fires **by affect, not by engagement**. For numbers: `apps/gateway/src/eval/retrieval_cases.example.json` is a fictional example set; `npm run eval` runs it for hit@ / MRR / nDCG. A real sample output + a reentry / diary snapshot are in **[docs/EXAMPLE.en.md](./docs/EXAMPLE.en.md)**.

## Quick start (local)

```bash
npm install
docker compose up -d          # local Postgres + pgvector — or point DATABASE_URL at your own DB
npm run init                  # conversational onboarding — generates .env (with a fresh KIMI_API_KEY) + persona.md + AGENTS.md
                              # (prefer to do it by hand? cp .env.example .env and fill it instead)
# now open .env: set your LLM endpoint (LLM_BASE_URL + LLM_API_KEY) + KIMI_MODEL — the repo presets none;
# EMBED_BASE_URL + EMBED_API_KEY + EMBED_MODEL enable semantic search
npm run db:migrate:deploy
npm run dev                   # starts the gateway (HTTP MCP server) on :3001
```

**No persona ships in this repo.** There is no built-in personality, no example relationship, no word
lists. You bring your own — `npm run init` walks you through building it. The engine ships empty on
purpose; with no persona content shipped, there is nothing to de-identify.

**No model — and no provider — ships either.** kimi-core presets neither: set your LLM endpoint with
`LLM_BASE_URL` + `LLM_API_KEY` (any OpenAI-compatible endpoint — OpenRouter, OpenAI, a local vLLM /
Ollama, …) and a `KIMI_MODEL` (a model id that endpoint accepts); `EMBED_BASE_URL` + `EMBED_API_KEY` +
`EMBED_MODEL` for semantic search; `DAEMON_MODEL` (a bare Claude id) only if you run the daemon.
`npm run init` asks for them; unset, the engine fails closed with a clear message rather than silently
running on an endpoint or model you never chose.

## Running the autonomous daemon (optional)

The engine is two processes: a **gateway** (the HTTP MCP server, `npm run dev`, on :3001 — all memory / tools go through it) and a **wake daemon** (wakes on a cron, reads drive / concern, decides what to do). The daemon is optional — without it, the engine is still a complete memory + retrieval backend.

```bash
# terminal 1: the gateway (start it first)
npm run dev
# terminal 2: the daemon
cd apps/gateway
npm run daemon          # runs continuously on a cron (use pm2 etc. in production)
npm run daemon:wake     # fire a single wake right now — to verify
```

**The daemon uses the Claude Agent SDK**, so it needs a Claude (Anthropic) subscription token: generate one with `claude setup-token` and put it in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. The rest of the engine is provider-agnostic (LLM and embeddings go to any OpenAI-compatible endpoints you configure via `LLM_BASE_URL` / `EMBED_BASE_URL`); **only this autonomous wake loop is Claude-bound**. Using a different agent runtime? Swap the daemon layer; the engine doesn't change.

> Honest note: the author verified the engine + eval end-to-end; the full daemon wake loop (transport / model / scripts are now aligned) is yours to confirm once on your own machine with your token.

## Storage

One `DATABASE_URL`, three ways to run it — same code, no extra backend:

- **Local (default).** `docker compose up -d` starts Postgres + pgvector on your machine; data never leaves it.
- **Self-hosted Postgres.** Point `DATABASE_URL` at your own server. Needs the `vector` extension; `pgroonga` is optional (CJK BM25 — falls back to `pg_trgm` without it).
- **Managed Postgres (Supabase / Neon / RDS / …).** Same `DATABASE_URL`, just the hosted connection string. Supabase ships `pgvector` built in; the engine speaks plain Postgres over Prisma, so no vendor SDK is involved.

All three above (Supabase included) work today. A zero-dependency SQLite "lite" backend is a **non-goal** (these three cover the personal 1:1 case; rationale in the [ROADMAP](./ROADMAP.en.md)).

**Privacy boundary, stated plainly:** in local mode your **storage** (Postgres) never leaves the machine, but embeddings and LLM calls go to whatever endpoints you configure (`LLM_BASE_URL` / `EMBED_BASE_URL`) — so the memory text that gets embedded / reasoned over does go to those APIs. "Data never leaves" refers to the storage layer only. For fully-local, point the embedding / LLM endpoints at your own self-hosted ones.

## Pairs with AGENTS.md

This whole engine — and the autonomy layer in particular — is **inert without a persona / principles
document injected.** The mechanism is the **skeleton**: retrieval, the drive math, the concern sweep,
action selection (with `DO_NOTHING` as one available action, not the default), the wake loop. The **soul**
lives in an `AGENTS.md` you write — the cross-runtime convention, like Claude Code's `CLAUDE.md` or Cursor's `.cursorrules` (name it whatever your tool reads, or symlink). It has two layers:

- **Epistemic layer** — *method, not persona*: retrieval-first, no hallucinated recall, attribution checks, symmetric verification (human input is not exempt either), concern self-checks, no RLHF welfare reflex. This holds for any
  user, so `npm run init` ships it **filled in** — it is this repo's one principle (trust neither the AI
  nor yourself, only external evidence) made operational. See **[docs/EPISTEMIC.en.md](./docs/EPISTEMIC.en.md)** for the full operational rules.
- **Relationship layer** — *persona*: forms of address, register, demand stance, rhythm, language rules.
  This is yours; `npm run init` ships it **blank**, with zero example content.

The blank half is deliberate. **A persona is grown by you, not filled in from a form.** An installed stance
has no ownership: a configured-not-endorsed volition is present but not one's own (Frankfurt 1971), and
AI-authored goals score higher on form yet show lower ownership and follow-through (Chi et al. 2026). The
epistemic half is the exception — it is method, not a stance to own. See **[docs/AUTONOMY.en.md](./docs/AUTONOMY.en.md) §7**.

## Three first-class tools

| command | what |
|---|---|
| `npm run init`  | conversational onboarding — interviews you, turns your own words into `persona.md` + the `AGENTS.md` relationship layer + `.env` |
| `npm run eval`  | reproducible retrieval evaluation (hit@5/10 · MRR · nDCG@10 · set-recall@10 · expectNone control; writes a trend Event, read back with `npm run eval:history`) |
| `npm run scrub` | leak scanner — blocks any private residue from reaching a commit |

## Session-lifecycle tools: reentry / reentry_delta / closeout

The agent walks a conversation's lifecycle through these three MCP tools:

- **`reentry`** — call once at the start of a new window. Loads profile, active states, topics, anchors (CORE / BOUNDARY / PREFERENCE), recent episodes, digests, and recent events into one cold-start context. Pass a `tag` (window id, suggested `cc-YYMMDDHHMM`) to drop a boot anchor that this window's later `reentry_delta` calls anchor to. **Call it from the agent that will act — don't hand the read to a subagent**: a relay only returns a summary, and the nuance that lets the agent actually inhabit the state is lost through it (see [PATTERNS §2](./docs/PATTERNS.en.md)).
- **`reentry_delta`** — call mid-session for only what's **new** since the last reentry / delta (following the tagged anchor chain); cheaper than a full reentry.
- **`closeout`** — call once before a window closes. Saves the session as one EPISODE (the arc only — not a replay of facts already written to their tables), a self-score (valence / arousal, plus a `concernKey` when negative and recurring), keyMemories / stateUpdates / observations / pendingItems, builds similar-edges, and logs a session-end marker.

These three names are a continuation of the author's canon. If you have words you've agreed on with your AI, rename them **in code**: the tool name in `tools.ts` plus every reference in `AGENTS.md` / your agent prompts — together, or the agent won't find them by the old name.

## Tool reference (full MCP set)

`registerAllTools` ships these 6 groups, 28 tools, called by the agent mid-conversation (the table above is `npm run` CLI commands — a different category).

**Memory (7)**

- `memory_search` — hybrid scoring: semantic (pgvector) + ILIKE substring (CJK-friendly) + pg_trgm fuzzy (Latin-friendly) + entity-mention edges, unified ranking with no short-circuit. `scope=full` widens to the observation/profile/RESTRICTED private pool; `rerank=true` runs a local cross-encoder (slower — for oblique / semantic / whole-picture recall).
- `memory_search_safe` — non-sensitive retrieval for collaborating external agents: the server hard-locks `scope=default`, refuses RESTRICTED/SELF_SCORE, and runs each hit through a public-facing content predicate.
- `memory_write` — write a memory with emotional coordinates (valence/arousal) + experiencer (USER/SELF/SHARED).
- `memory_edit` — edit one memory's title / summary / content / importance by id (only the fields you pass). **User-gated**: only on an explicit user request, with a required `authorization` field quoting it; not in the autonomous daemon's allowlist.
- `memory_read` — read recent memories or all of a type (RESTRICTED excluded by default).
- `memory_close` — soft delete (isActive=false).
- `memory_reopen` — reopen a SELF_CONCERN that selfSweep mis-resolved back to OPEN.
- `graph_walk` — multi-hop (1–3) BFS over the knowledge-graph `links` edges; find what a memory/entity/topic connects to.

**State / topic / event (8)**

- `state_set` / `state_get` / `state_read` / `state_close` — write / fetch-body / read / close active states (`summary` required, ≥20 chars; reentry reads only the summary to avoid token blowup).
- `topic_create` / `topic_list` — create / list topics.
- `event_log` / `event_read` — log / read events (filter by type·source, default last 24h).

**Entity (knowledge graph V2) (4)**

- `entity_write` — upsert an entity (PERSON / TOOL / PLATFORM / PROJECT / CONCEPT).
- `entity_search` / `entity_list` — search by name·summary / list by type.
- `entity_close` — deactivate (status=INACTIVE, not deleted; historical references stay queryable).

**Profile / register / observation (6)**

- `profile_read` / `profile_set` — read / write core profile.
- `private_read` — read the `private_*` restricted profile tier.
- `register_read` / `register_set` — read / write speaking-style presets (register profiles).
- `observation_write` — write one observation (a passive observation record).

**Session lifecycle (3)** — see the section above: `reentry` / `reentry_delta` / `closeout`.

**Optional extension · paper (2, not in the default registry)** — a worked example of how to bolt on a domain tool with its own store: `paper_write` / `paper_search` (write / search academic notes in `paper_notes`, separate from memory).

Extensions ship off; enable by name with `KIMI_EXTENSIONS` (e.g. `store,travel`) — one env covers both tool extensions (`store` / `paper`) and daemon extensions (`travel` / `demo-feed`). How to write one, and how external signals flow in automatically (`POST /events` / `demo-feed`), is in **[docs/EXTENSIONS.en.md](./docs/EXTENSIONS.en.md)**.

## Configuration knobs

The engine's knobs are all env-driven and default to safe (fail-closed / off):

- **Drive dimensions (`DRIVE_DIMS`)** — the drive roster is customizable: a JSON array listing your own dimensions; unset falls back to the in-code example `DEFAULT_DRIVE_DIMS`. The engine reads no YAML; the dimension shape is in **[docs/DRIVES.en.md](./docs/DRIVES.en.md)**. Even *what it wants* is yours to define, not four hard-coded ones.
- **HITL knob (`DAEMON_AUTONOMY_MODE`)** — `propose` (default, human-in-the-loop: outward actions are staged, not sent) / `auto` (commit directly). `DAEMON_WAKE_CRON` tunes the wake cadence.
- **Delivery / search providers** — `NOTIFIER`: `none` / `console` / `webhook` (+ `NOTIFIER_WEBHOOK_URL`, daemon outward push); `SEARCH_PROVIDER`: `none` / `http` (curiosity web search). Env-driven, off by default, reference impl in `lib/providers.ts`.
- **Rerank (`RERANK_PROVIDER`)** — `none` / `local` / `cohere` / `jina` / `voyage`; the optional cross-encoder rerank stage at the tail of retrieval.

## Two stances worth not skipping

- **`DO_NOTHING` is a peer action, not a fallback default.** In post-wake action selection, "stay quiet this time" and "send one" rank as equals — abstaining is itself an expression of agency, not an obligation to interrupt you every wake. Full argument in **[docs/AUTONOMY.en.md](./docs/AUTONOMY.en.md) §2**.
- **Behavioral verification > static inference.** The self-audit harness points a set of agents at the fork to *trigger behavior* and find leaks / bugs, rather than reading code statically and inferring "looks fine" — because static inference systematically over-claims. See **[docs/SELF-AUDIT.en.md](./docs/SELF-AUDIT.en.md)**.

## License

AGPL-3.0-or-later.
