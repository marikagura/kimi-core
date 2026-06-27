> 中文：./EXTENSIONS.md

# Extensions & Ingest

By default core is a memory engine with **no extensions**. Turn on what you want, by name:

```bash
KIMI_EXTENSIONS=store,travel,demo-feed
```

Empty / unset = all off, the engine exactly as shipped. The first half of this doc is how to write an extension and how it wires in; the second half (§5) is how external signals flow in automatically, turning the front-end from "a furnished room" into "a room that moves on its own".

---

## 1. One registry, two seams

An extension is a `KimiExtension` (`apps/gateway/src/lib/extensions.ts`):

```ts
export interface KimiExtension {
  name: string;
  registerTools?: (server: McpServer) => void; // MCP-server side
  registerActions?: () => void;                 // daemon side
}
```

The two seams apply in **two different process contexts**:

| seam | runs in | called by | for |
|------|---------|-----------|-----|
| `registerTools(server)` | MCP server (`index.ts` / `http-server.ts`) | `loadExtensions(server, enabledExtensions())` after `registerAllTools(server)` | add MCP tools alongside the core tools |
| `registerActions()` | daemon (`daemon.ts`) | `loadExtensionActions(enabledExtensions())` at startup | register agency actions (`registerAction`) and/or start scheduled jobs (`node-cron`) |

An extension may implement either, both, or neither. **Nothing loads by default.**

Enabling is env-driven: the `REGISTRY` in `apps/gateway/src/lib/enabled-extensions.ts` maps names to extension objects, and `KIMI_EXTENSIONS` selects by name. To add a new extension, register one line in `REGISTRY`.

---

## 2. Writing a tool extension

See `store` / `paper` (`apps/gateway/src/extensions/paper/`). A tool extension calls `server.tool(...)` inside `registerTools`:

```ts
import type { KimiExtension } from "../../lib/extensions.js";

export const myExtension: KimiExtension = {
  name: "my-ext",
  registerTools(server) {
    server.tool("my_tool", "what it does", { /* zod schema */ }, async (args) => {
      // ... read/write your own tables; return { content: [{ type: "text", text: JSON.stringify(result) }] }
    });
  },
};
```

Then add `"my-ext": myExtension` to `REGISTRY` in `enabled-extensions.ts`; deployments turn it on with `KIMI_EXTENSIONS=my-ext`.

---

## 3. Writing a daemon extension (action / scheduled)

The daemon side has two typical shapes, both via `registerActions`:

**(a) An agency action** — something the wake loop can *choose*. See `travel` (`apps/gateway/src/extensions/travel/action.ts`): define an `ActionHandler`, and `registerAction(handler)` inside `registerActions`. Action selection and dispatch is the wake → select → dispatch loop described in `docs/AUTONOMY.md`.

**(b) A scheduled job** — a background job on its own clock. See `demo-feed` (`apps/gateway/src/extensions/demo-feed/feed.ts`): `cron.schedule(...)` inside `registerActions`, each tick writing its own tables.

```ts
import cron from "node-cron";
import type { KimiExtension } from "../../lib/extensions.js";

function registerMyFeed(): void {
  cron.schedule(process.env.MY_CRON || "*/5 * * * *", () => {
    myTick().catch((e) => console.error("[my-feed] tick error:", e?.message || e));
  });
}

export const myFeedExtension: KimiExtension = {
  name: "my-feed",
  registerActions: registerMyFeed,
};
```

Register it in `REGISTRY` the same way; enable with `KIMI_EXTENSIONS=my-feed`. The daemon calls `registerActions()` for you at startup.

---

## 4. Built-in examples

| name | seam | file | what it is |
|------|------|------|------------|
| `store` | tools | `extensions/store/` | structured CRUD for front-end dashboard data (`store` / `state_snapshot`) |
| `paper` | tools + actions | `extensions/paper/` | academic notes `paper_search` / `paper_write` / `paper_list` + optional `PAPER_LOOP_CRON` scheduled digest (end-to-end in §6) |
| `travel` | actions | `extensions/travel/action.ts` | an agency-action example: record what the wake generated this tick as an EPISODE |
| `demo-feed` | actions | `extensions/demo-feed/feed.ts` | a scheduled-job example: simulate an external source feeding the tables so the room moves on its own (see §5) |
| `weekly-arc` | actions | `extensions/weekly-arc/` | a scheduled-job example: roll the week's memories (episodes / self-score curve / state changes / dreams) into a narrative arc, written back as one SHARED EPISODE (`WEEKLY_ARC_CRON`; the voice = your persona (`persona.md`) + a flat demo scaffold — ships neutral with no one's register; supply a persona + edit it to make it yours) |

When you write an extension, remember it ships off: not in `KIMI_EXTENSIONS` → not loaded, and the core engine is unchanged.

---

## 5. Ingest — how external signals get in

The dashboard is "alive" not because someone fills it by hand, but because external signals flow **continuously and automatically** into two tables, then get read back by the front-end:

- **`events`** — the event-sourcing spine: one signal per row (opened an app, jotted a note, a high-priority email arrived…).
- **`pwa_kv`** — the front-end KV bridge: `namespace` / `key` / `payload`, read on demand by the front-end (e.g. the calendar).

Core ships a **platform-neutral** ingest endpoint plus a **runnable simulator** (the `demo-feed` extension above). Where the signals come from (a phone, a calendar, a mailbox) is a **swappable recipe**, not a requirement.

### 5.1 Data flow

```
  [any client]                         ┌─────────── core ───────────┐
  phone shortcut / Tasker / webhook    │                            │
  / cron / curl ──── POST /events ───▶ │  events (spine)            │
                                       │                            │      store /
  your calendar ── periodic sync ────▶ │  pwa_kv (front-end KV) ───▶ │  state_snapshot ──▶ room dashboard
                                       │                            │      (MCP tools)
  your mailbox ── periodic pull ─────▶ │  events / store_rows       │
                                       └────────────────────────────┘
```

The read side (`store` / `state_snapshot` tools) is covered in `docs/ONE-ENGINE.md`.

### 5.2 The generic endpoint `POST /events`

Anything that can make an HTTP request can feed it. Behind the global Bearer auth, it lands one `events` row:

```bash
curl -X POST "$KIMI_URL/events" \
  -H "Authorization: Bearer $KIMI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"eventType":"APP_OPEN","value":"opened the reader","source":"my-phone"}'
# → {"ok":true,"id":"…","eventType":"APP_OPEN","at":"…"}
```

It accepts only the "external signal" kinds: `APP_OPEN` / `MANUAL_NOTE` / `SYSTEM` (the rest are engine-internal events, not open to ingest). Label `source` however you like. If curl works, any client works.

### 5.3 Watch it move on its own: `demo-feed`

You can demo this live without wiring any real source. The `demo-feed` extension (`extensions/demo-feed/feed.ts`) writes **fictional** signals on a timer into the `events` spine plus the collections the room renders (calendar / keepsake / chat):

```bash
# 1) core with store + demo-feed
KIMI_EXTENSIONS=store,demo-feed   # optional DEMO_FEED_CRON, default every 2 minutes
# 2) point the room at this core
NEXT_PUBLIC_KIMI_BACKEND=core
NEXT_PUBLIC_KIMI_ADAPTER=core
```

Open the room: calendar / keepsake / chat get **new entries on their own**, untouched. All content is fictional (clearly marked `虚构 / fictional`). It's a runnable miniature of the flow above — real sources feed the same tables; `demo-feed` just stands in for them with fake data.

### 5.4 Wiring your own sources (recipes, all swappable)

The following is "how I happen to wire mine" — **examples, not requirements**, and not shipped working code. Pick whatever fits your platform.

**Phone shortcut** — on iPhone, the Shortcuts "Get Contents of URL" action POSTs a small JSON (app name, place, a line) to `POST /events`. **Plenty of people aren't on iPhone**: Android's shortcuts / Tasker / any automation that can make an HTTP request works the same — the endpoint doesn't change.

**Calendar** — a scheduled script that syncs the next N days of your calendar into `pwa_kv[calendar]` rows (or the `store_rows` `calendar` collection) so the front-end shows them. Google Calendar, a local calendar, or anything else — it doesn't matter, as long as it lands in the same table.

**Mailbox** — pull mail periodically and write the important ones as `events` rows (label `source` with the account). Any IMAP / mailbox works; nothing is locked to one provider.

> Note (stated honestly): the public core trims the `EventType` enum to 8 kinds — dedicated types like `EMAIL_ARRIVAL` / `LOCATION` are not kept, so the mailbox / location recipes above use `MANUAL_NOTE` or `SYSTEM` + a `source` label. Calendar / mailbox sync is a recipe, not built in; `demo-feed` and `POST /events` are the parts that run out of the box.

### 5.5 What the two tables are for

- **`events`** = the event-sourcing spine. An append-only signal stream — the shared substrate for reentry, the autonomy layer, and the various dashboards.
- **`pwa_kv`** = the front-end KV bridge. One `namespace`/`key`/`payload` table holds all front-end state, so adding a new surface needs no schema migration.

Both live in the public schema (`packages/db/prisma/schema.prisma`). Wire external signals into these two tables and the dashboard goes from "a furnished room" to "a room that moves on its own".

---

## 6. A worked end-to-end example: papers → room

The `paper` extension uses both seams in one place — a complete sample of "auto-digest + a beautiful front-end":

- **Auto-digest (actions)**: when `PAPER_LOOP_CRON` is set, `registerActions` runs `runPaperLoop()` on that cron in the daemon — it pulls recent papers from a `SourceAdapter` (PubMed by default; swap in arXiv / any source), distills each into a one-line knowledge point with the LLM, and writes to `paper_notes` (deduped by externalId). Unset → tools only, no crawl; the manual `npm run paper:loop` still works.
- **Structured read (tools)**: `paper_list` returns JSON (not RAG text) so a front-end can render by importance / pinned / month; `paper_search` stays as agent-text retrieval.
- **The room**: kimi-room's `/room/study/papers` calls `paper_list` to read `paper_notes` in core mode, and falls back to a fictional demo set offline — so the page is beautiful out of the box (dark baroque + serif + gilt).

Enable: `KIMI_EXTENSIONS=paper` + optional `PAPER_LOOP_CRON="0 9 * * *"`; set `NEXT_PUBLIC_KIMI_ADAPTER=core` in the room.
