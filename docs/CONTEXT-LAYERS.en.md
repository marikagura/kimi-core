# Context layers & injection

kimi-core defines "what to query + how to layer it" once, in `@kimi/context-core`
(`packages/context-core/src/index.ts`). Every surface — text chat (tg), voice, the web
chatroom, the agent harness (cc) — is a different output of the same agent, not a separate
system. So the "which tables, how to layer" logic is written once; each output
(`turn-context.ts` / `tools-reentry.ts`, etc.) is only a thin format layer.

This doc covers: which layers exist, where each comes from, and how each surface injects
them. It contains none of a deployment's actual content — the engine defines the structure,
you supply the content.

## The layers

Each layer loads independently, so any output composes only the slices it needs.

| layer | source | what it is |
|---|---|---|
| profile | `coreProfile` | resident identity / setup entries (ordered by importance) |
| register | `registerProfile` | tone / style profiles (neutral defaults if none) |
| anchors | `memory` (CORE / BOUNDARY / PREFERENCE) | long-lived rules and preferences, resident in full |
| states | `activeState` | in-progress states (summary injected; full body on demand via `state_get`) |
| observations | `observation` | structured reads about the user / assistant |
| episodes | `memory` (EPISODE) | recent salient narrative memories (top-N by importance) |
| topics | `topic` | active topics |
| digests | `memory` | dialogue digests — past conversations compressed into summaries |
| events | `event` | recent non-chat signals (git commits / app opens / calendar, etc.) |
| entities | `entity` | person and project cards |
| persona | external `persona.md` | address / register / principles; not shipped — injected from your file |
| merged-chat | `event` (CHAT) | one cross-surface conversation timeline (see below) |

> You supply the content: profile / memories / persona / register are all filled by the
> deployment. The engine defines layers and injection; it ships with no content.

## How injection works

### Cold start — the `reentry` tool

At the start of a new window, call `reentry` once. It assembles these layers into one
cold-start block in a fixed order: Profile → Active States → Active Topics → Anchors
(CORE / BOUNDARY / PREFERENCE) → Observations → Recent Episodes → dialogue digests →
recent raw chat → Recent Events. The "recent raw chat" slice lets a new window pick up the
current conversation directly (not only from summaries). It is injected as-is; add a denylist
there if a deployment needs to hold some rows back. `reentry_delta` returns the increment
since this window's last anchor.

### Per turn — `turn-context`

When generating a reply to each message, the merged chat timeline plus the needed layers
are composed into the prompt.

### merged-chat: one agent, one conversation

CHAT events are merged by `createdAt` (a single server clock) into one timeline, so
multiple surfaces read the same conversation — what you said on one surface continues on
another. The merge is done server-side by `loadMergedChat` (for prompt building). To render
this timeline in a front end, use a read-back tool / endpoint (see the ingest section of
`docs/EXTENSIONS.md`). Cold start (reentry) also injects a recent slice of raw chat so a new
window picks up the current conversation directly (injected as-is by default; add a denylist if needed).

### Lean vs full — `canMcp`

A surface that can self-query (the chatroom can re-query over MCP) injects some layers lean
(title / index) and fetches detail on demand; a surface that cannot back-fill (push
surfaces: tg / voice) injects in full, because the push moment cannot be recovered later.
This is the `ContextOpts.canMcp` signal to the format layer.

### Per-surface selection

A surface decides which layers compose into its output. Some layers are injected
selectively per surface (each loader documents its own rule: it returns null and is skipped
where it does not apply).

### Cold-start exclusion hook

`lib/reentry-filter.ts` is a hook that ships empty: a deployment can configure which rows
stay out of cold start (by title / prefix / content rule). The default excludes nothing —
the engine runs out of the box with no denylist.

## What you define

The engine provides the mechanism — which layers exist and how they're injected. You fill
in the content and the classification rules:

- The content of each layer (profile / memories / observations / topics / entities).
- `persona.md` (address / register / principles).
- Optional: cold-start exclusion rules (`reentry-filter.ts`), anchor ids / prefix scheme.
