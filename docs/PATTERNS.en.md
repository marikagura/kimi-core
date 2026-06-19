# Engineering patterns · pitfalls we hit

> 中文版: ./PATTERNS.md

Most of these aren't part of the engine core — they're the traps we hit, repeatedly, building this whole thing (the engine itself plus its surfaces: a chat endpoint, the wake daemon, push, a dashboard). One bottom line runs through all of it: **trust no claim, only external evidence** — whether the cache hit is in the token counts, whether the SQL is right is on a real DB, an audit finding is real once you reproduce it.

> **How to read this.** The body is the **non-obvious** traps — silent failures (no error, output still correct, you only lose it on the bill or in the data) and **domain-specific** ones (you only hit them forking this engine), grouped by theme. Generic backend hygiene (most experienced engineers already do it) is collected at the end in **[Appendix · table-stakes](#appendix--table-stakes-hygiene-skippable-if-experienced)**, kept for newcomers, uncompressed. The cut is simple: **if tsc / one run catches it**, it's table-stakes; **if you only find it on the bill or in the data**, it's in the body — which is the flip side of "trust only external evidence."

## 1. Prompt caching: the silent money traps

**The foundational rule: caching is a prefix match. Change any byte in the prefix and everything after it is invalidated.** Render order is fixed `tools → system → messages`; the cache key is the exact bytes up to each `cache_control` breakpoint. So put the **unchanging** content first (persona / principles / long-lived memory / a fixed tool list) with `cache_control`, and the **per-turn** content (timestamps, a git commit, this turn's activity) **after the last breakpoint** (in the last user message). That rule is common knowledge; what's hard is that it **fails without an error** — these all violate it with no error at all:

- **A changing identifier inside the cached prefix and ahead of the history** — the moment it changes it **cascades** and invalidates the whole history cache behind it. You re-write tens of thousands of tokens a turn while believing the cache works.
- **A sliding history window breaks the cache by itself.** "Last N messages" drops the oldest each turn, shifting the prefix and forcing a full re-write every turn. Fix: anchor history **append-only from session start** (by `sinceTs`), trim only from the oldest end under a hard cap.
- **A marker ≠ a hit.** Read `cache_read_input_tokens`: if it stays **0** across an identical prefix you have a silent invalidator (`Date.now()`, unsorted JSON, a varying tool set). **Diff the rendered bytes of two requests to find it.**
- **Several silent limits**: at most **4** breakpoints per request; below the model's minimum cacheable prefix (commonly 1k–4k tokens) it **silently won't cache** (`cache_creation`=0, no error); a **20-block lookback** — a turn with > 20 tool_use/result blocks misses the prior cache, so add an intermediate breakpoint every ~15 blocks in long turns.
- **Multi-turn:** put the breakpoint on the last block of the most recent message (prefix = stable + whole history, accruing turn over turn); give the long-lived persona its own breakpoint.
- **OpenAI-compat endpoints**: `cache_control` on the tools array 400s — put it on the system message; cached tokens live at a nested path like `usage.prompt_tokens_details.cached_tokens`, and reading the wrong path shows 0% hit all day.
- **Don't change tools / switch model mid-session**: tools render at position 0, so any change rebuilds the whole cache; caches are model-scoped.
- **Reconcile your price table against live rates.** A hardcoded per-token table a generation stale inflates reported spend several-fold — token counts right, multiplier old. Check against the provider's models API; backfill historical rows (keep the old value in a column for rollback).

> Why caching doesn't violate "no auto-consolidation": it's plumbing that saves money on a **disposable transcript buffer** — it doesn't summarize, conclude, or claim what the conversation "was." That's different from auto-compaction (which *does* render a compressed judgment). The first is neutral, do it fully; the second carries a judgment and this repo doesn't do it (see [AUTONOMY.en.md](./AUTONOMY.en.md)).

## 2. Cold-start context: load it yourself, not via a subagent

When you boot a session, the work of loading cold-start context (profile, active state, recent memory, recent commits — `reentry` here) must be done by **the agent that will act**, not handed to a subagent to save the main context's tokens.

The temptation is real: that big read is expensive in the main context. But a subagent can only return a **summary**, and the nuance that makes the agent actually *inhabit* the state / relationship — register, the exact phrasing of a commitment, the edge of a boundary — doesn't survive a relay. **The value of context is that it's resident in the agent that acts; outsourcing it to a subagent reduces it to a summary first.** Pay the tokens.

- **Anchor the boot with a label/tag** (e.g. `cc-YYMMDDHHMM`) so a mid-session delta (`reentry_delta`) fetches only what's new since that anchor — that's how you bound the ongoing cost, not by re-reading everything each time. The labeling itself costs a few tokens, but it buys cheap deltas.
- **Fetch the recent commits while you're at it**: what happened at the code level is part of grounding — don't infer it from the conversation, don't wait for an error to check.
- In a line: the temptation to save tokens makes you outsource the read — but the whole point of context is residence, and outsourcing is reduction.

## 3. Prisma / pgvector

- **Don't let Prisma touch an `Unsupported("vector")` column.** Prisma can't deserialize a pgvector column; a default `findMany` / `create … RETURNING *` still SELECTs it and throws — `create` throws first, masking that all reads are broken too. `omit` won't help (`Unsupported` fields aren't exposed to the client). Approach: **declare** the column in the schema (so `db push` doesn't DROP it as unknown), but route all vector read/write through `$queryRaw` / `$executeRaw`. **Never `prisma db push --accept-data-loss`** — it silently drops columns it doesn't know about (that's how a whole table of embeddings got lost).
- **A deployed client lagging a new enum value crashes every full-column read.** Add an enum value to the DB without regenerating the client and any query returning that enum column throws `Value X not found in enum`, silently killing background loops. Defenses: read display rows via `$queryRaw` + `"col"::text`; add a `postinstall: prisma generate`. Note `git pull` + restart does NOT run install, so a manual `db:generate` is still needed.
- **Don't proxy a real condition with a correlated-but-not-equivalent column.** Counting "missing embeddings" via `embeddingAt IS NULL` overcounted by 180-odd because a row can have a vector and a null timestamp; the true `embedding IS NULL` count was 0. Query the condition you mean.
- **Index graph / link tables on both directions** (`[fromType,fromId,relationType]` and `[toType,toId]`); build with `CREATE INDEX IF NOT EXISTS` + Prisma's naming so `db push` doesn't re-detect.

## 4. Retrieval / eval

- **A semantic-only search needs a similarity floor — tuned from measured data, not guessed.** Base embedding similarity (notably CJK) is high enough (~0.3–0.5) that unrelated queries pass a low final cutoff and return random neighbors. Measure the **gap** between "unrelated" and "truly similar" on a real eval set and set the floor in the gap; too high (0.5) silently drops genuine matches at 0.43–0.49. Strong keyword / entity hits should **bypass** the floor.
- **Only put cases your data can satisfy into the eval set.** "Failures" that are really missing source data (no memory body contains the term) should be removed, not treated as algorithm bugs. Negative controls (`expectNone`) are their own class — keep them out of the headline hit@ / MRR.
- **Re-embed on edit, not just on null.** A sweep that only embeds NULL-vector rows leaves stale embeddings after edits; stamp an `embeddingAt` and re-embed when `updatedAt > embeddingAt`. Size the batch so a backfill finishes in one run.
- **Stand up the eval harness (nDCG / hit@k + a regression alert) before tuning thresholds** — measurement first, on a cron, compared to a rolling average, so tuning is data-driven.

## 5. Concurrency / cron / agent safety

- **`allowedTools` is a pre-approval list, not a whitelist.** Tools not listed are **still callable** and fall through to the permission mode. To actually restrict an autonomous agent, set a deny-by-default permission mode **and** add a programmatic `canUseTool` gate.
- **Don't fire-and-forget writes in serverless.** Vercel / serverless kills the instance after `controller.close()`, so an un-awaited `void prisma.create(...)` never lands; `await` before closing.
- **Self-heal scheduled jobs with a watchdog + startup catch-up.** A stale client made a twice-daily briefing silently stop for ~9h with no alarm. A watchdog cron detects a missed slot (past grace, no event since) and restarts; a startup catch-up delivers a genuinely-missed slot once — guarded so a routine restart after a successful slot doesn't re-fire.
- **`setState` updaters are deferred, not synchronous.** Mutating an outer `let` inside a React 18 `setState((s)=>…)` and reading it before commit — the value is still empty when `fetch` runs. Compute the next value synchronously with a plain `const`.

## 6. Credentials / secrets / auth

- **Don't return a real token from an anonymous endpoint.** An OAuth `/token` stub that returns the master API key to any anonymous POST is a full auth bypass. If clients use a static Bearer, **delete** the whole `.well-known` / `register` / `authorize` / `token` surface — an unused auth surface is pure liability.
- **Fail closed on config — ship no default.** Never `process.env.X || "some-default-key/model/endpoint"` — error clearly at startup and exit rather than silently running on an endpoint / model the user never chose. A missing key is a hard startup failure, not a silent open door.
- **Compare secrets in constant time.** Don't validate a Bearer with `===` — a plaintext compare leaks the key byte-by-byte via latency. Length-guard, then `crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))`.
- **Exclude secrets structurally from every injection surface.** Credentials stay out of prompts often only by luck of ranking, not structure. Walk every passive injection path (retrieval, recent-memories, digest, profile…) and add an explicit credential filter to each — rank won't hold.
- **Third-party OAuth refresh tokens rotate.** Catch the rotated token via the SDK's token event, **persist** it, stamp `lastRefreshedAt`; on `invalid_grant` flip to FAILED and surface it; keep tokens DB-primary (not `.env`) and run a daily refresh probe with an alert on failure.

## 7. Parsing a model's JSON output

- **Layered fallback, not one greedy regex.** Models intermittently wrap JSON in ```` ```json ```` fences and truncate at `max_tokens`, leaving unclosed braces a greedy `\{[\s\S]*\}` won't match. **Strip fences first**; on parse failure, **regex-extract individual fields** so the critical one survives; pin "pure JSON, no fences" and cap the output size in the prompt.
- **Empty outputs have several independent causes — budget for all**: `max_tokens` too small for a longer prompt's JSON; reasoning / thinking tokens counting against the completion budget — raise the cap to leave room for both.

## 8. Data modeling / dedup / defaults

- **A "only new since last run" clause permanently strips a backlog.** A `createdAt >= since` filter on pending items means anything skipped by a per-run cap is **never retried** (its `createdAt` predates the next `since`). Drop the time filter and rely on slug-based dedup (e.g. 48h) — still retries stuck items. For gappy event streams, a **fixed look-back window** (e.g. 12h) beats "since last success," which misses signals that landed during a suppressed window.
- **A schema `@default` silently enrolls records into expensive processing.** Three create-paths never passed a `resolution`, so a `@default(OPEN)` pulled dozens of routine rows into a continuous LLM sweep — hundreds a month. Set the field **explicitly** at every write site, backfill the mis-defaulted rows, give the rare true cases a reopen tool.
- **DRY drift becomes a correctness bug.** Cross-surface contracts (event-type names, parse logic, tool schemas) duplicated in two places drift: two transport entries each missing the other's tools, same-named schemas disagreeing (slug vs id), one leaking keys the other filtered; a daemon writing one eventType while the reader queries another makes commits silently invisible. Extract cross-surface contracts into **one** registry / module.
- **Pick a dedup key that's stable and free of glitchy fields.** Keying on an internal id breaks when grouping changes; keying on a noisy upstream timestamp produces duplicate notifications on re-emit. Use a stable natural key (date + content); key user-facing dedup on the slug / identity.
- **An ASCII-only slugify drops CJK.** A slugify that assumes ASCII strips a Chinese identity key to an empty string and key-aggregation breaks. Keep slugify Unicode-aware.

## 9. Retry / timeouts / resilience

- **Treat pool exhaustion as a transient to retry.** When several services share one session-mode pooler (low ceiling), queries **silently return empty** rather than erroring. Wrap each parallel query (tolerate a single empty result) so one rejection in a `Promise.all` doesn't 500 the dashboard; retry transient connection errors 3×; the real fix is a transaction-mode (pgbouncer) pooler + a higher ceiling.
- **Tier your timeouts.** A generic fetch default (say 60s) is fine for ordinary APIs but **aborts a slow LLM generation** (extended thinking / long output can run minutes). Give the LLM caller its own much-higher per-attempt timeout (180s range).
- **Long-idle SSE streams get killed by client body timeouts.** An idle SSE connection dies after ~5 min when the client's (undici) `bodyTimeout` fires; emit a periodic `: keepalive` comment every ~25s and `clearInterval` on close.

(The retry basics — prefer the official SDK, hand-rolled backoff rules, wrap every call, per-surface strategy — are in the [Appendix](#appendix--table-stakes-hygiene-skippable-if-experienced).)

## 10. Time / timezone

- **Inject "now" into any LLM context that reasons about time.** Without a "now" header the model **infers** current time from event timestamps and gets intervals / relative times wrong; pass an explicit `current: YYYY-MM-DD HH:MM`, and the **weekday** too.
- **Event time ≠ write time.** A record's `createdAt` (write time) is not the time of the thing it describes; ground temporal reasoning in event time + a **freshness gate**, or days-old conversation gets quoted as current presence.
- **A timestamp-stripping regex must cover every separator the producer might emit.** A filter that only matched hyphen dates leaked prefixes when the producer switched to slashes; use a `[-/]` character class.

## 11. Migrations / schema evolution

- **Don't rely on `prisma db push` when the pooler is connection-constrained.** A 15-connection Supabase pooler with processes running makes `db push` fail (`EMAXCONNSESSION`). Writing `ALTER TABLE … ADD COLUMN IF NOT EXISTS` into a checked-in SQL file run via one `psql` does schema + backfill reliably.

(Idempotent migrations and a consumer fallback when adding a column are in the [Appendix](#appendix--table-stakes-hygiene-skippable-if-experienced).)

## 12. Utility LLM calls: frame as a pure transformer

When you use a (usually cheap) model as a **transformer over user content** (translate / normalize / classify / extract / summarize one message), it can mistake that content as **addressed to it** and respond / refuse / moralize / add a disclaimer instead of transforming. The cheaper the model, the likelier. The fix is in the system prompt:

- Narrow the **role** ("you are ONLY a translator / classifier"); state the input is **not addressed to it** ("one line from someone else's conversation"); **forbid the failure modes** ("NEVER respond / refuse / moralize / add a disclaimer"); pin the **output shape** ("output EXACTLY two lines `EN:` / `ZH:`") so a stray refusal is structurally obvious and easy to reject.
- **Put hard constraints at the top of the prompt, not buried.** A "don't do X" a thousand-plus lines deep gets overridden when the injected context is saturated with the opposite signal — intermittent, context-triggered. Hoist it and name the trap.

## 13. Build / CI

- **A lockfile is platform-specific.** A lockfile generated on macOS misses Linux's native optional deps (esbuild / tsx's `@emnapi/core`), and CI then fails `npm ci` on the Linux runner. Use `npm install` in CI, or generate a multi-platform lockfile — `npm install --package-lock-only` on a single OS won't capture other platforms' optionalDependencies.
- **Don't depend on the CI runtime stripping TS for you.** A build that runs `node script.ts` assuming native TS strip breaks when the CI Node (22.x) doesn't strip and there's no `.nvmrc` / `engines` pin. Make the hook fail-soft (a committed fallback artifact) and pin the Node version.
- **Static review systematically over-claims.** Static inference hunting bugs over-claims; an audit finding is trusted once you **reproduce it behaviorally** (one real run). Which is why verifying DB-bound paths means starting a real DB, not just tsc + unit tests.

## 14. Observability

- **Always log "I ran, here's what I saw" — not only "I did something."** A poller that logs only when it adds rows makes a silent zero-result run indistinguishable from not running; emit a per-run `checked N · added N · skipped N`. Add temporary `debug:` logging to diagnose why an upstream returns nothing, then revert.
- **On total failure, write an explicit audit / fallback marker instead of nulling.** A scoring call that returns null writes nothing and leaves a silent gap; write a `*_failed` audit row (and retry once) so the gap is visible. Surface the upstream error body in client-facing errors, not a bare status code.

## 15. Third-party APIs / scraping

- **Scrape from a stable structured source, not best-effort HTML.** Title / body extraction via HTML regex returns a random element (often a comment); pull the token / id from the URL query and call the structured detail API.
- **Rate-limit, jitter, and rotate when scraping a consumer platform, or the account gets flagged** (a shared daily cap, a reused session cache, cron jitter to break the fingerprint, rotated targets, back off on a warning). **Private-repo webhook payloads omit fields public ones include** (GitHub returns an empty `payload.commits`) — fall back to the compare endpoint and always emit a marker. **Prefer the cheapest API format that has the field you need, and verify version compat** (`format=metadata` may 400; `format=minimal` both works and is cheaper).

## 16. Frontend surfaces: PWA / Electron

- **Don't serve page HTML stale-while-revalidate.** A service worker caching navigation HTML stale-while-revalidate serves a stale theme / state and refreshes in the background after the user has navigated past. Use **network-first** for navigation / document requests (cache only as offline fallback), stale-while-revalidate for data / RSC; bump the SW version to flush old HTML. Handle iOS Safari's bfcache separately (a `pageshow` listener that reloads on a state mismatch).
- **Persist Electron window position / size by viewport ratio, not absolute pixels** — pixels don't line up across window sizes / maximize. Clamp drag / restore to bounds; give a double-click-title reset.

---

## Appendix · table-stakes (hygiene, skippable if experienced)

These are caught by **tsc / one run / one deploy** (a loud, immediate error), so they stay out of the body — but a newcomer forking this may not know them all, so here they are, grouped:

**Retry**
- Prefer the official SDK: auto-retries connection errors / 408 / 409 / 429 / ≥500 with backoff, honors `retry-after`.
- Hand-rolled raw-fetch: exponential backoff + jitter, honor `Retry-After`, branch on status (retry 429/5xx/529, not 4xx), cap attempts + an overall timeout.
- Wrap every bare `fetch()` to an upstream in a retry helper (one `ETIMEDOUT` otherwise crashes the cron); outbound webhooks via a retry queue.
- Different surface, different policy: interactive throws and lets the user resend; background / cron backs off and retries.

**Config / auth**
- Each entry point does its own `import "dotenv/config"` — a shared module assumes env is loaded, but an entry that didn't load it crashes.
- "Cookie present" isn't auth: verify a **signed** cookie / token match, and re-check defensively per route.

**DB / migrations**
- Quote camelCase column names in raw SQL (`@@map` maps only the table; unquoted, Postgres lowercases → `42703`).
- A single-row upsert keyed only on type silently overwrites another of the same type → key on `(type, title)`.
- Make migrations idempotent (`ADD COLUMN IF NOT EXISTS`) and check them into the repo; one applied by hand and never committed is a bomb.
- Add a nullable column with a `slice()` fallback + warning, not a hard block on old rows.

**Time / cron**
- One timezone source = an IANA zone (e.g. `Asia/Shanghai`), not a numeric offset (breaks across DST).
- Every cron schedule carries `{ timezone: … }`, or it fires at the wrong local hour.
- Cap the agentic loop (`maxTurns`) and lock concurrent ticks.

**JSON / provider**
- Provider-compat endpoints reject native fields (`cache_control` on the system message, not the tools array); always surface the upstream **response body** in errors, not just the status.
- Collapse JSON extraction into **one** helper, not copies that drift.

**Cost / caching**
- Move a per-event LLM sweep off the hot path: a week's evidence doesn't change within a day, so a daily cron drops it from hundreds a month to cents.

**Open-sourcing**
- Strip personal references before open-sourcing, and freeze it into a scanner (this repo's `npm run scrub`) that blocks private residue from a commit, rather than relying on remembering.

---

There's only one bottom line, and it runs through all of it: **trust no claim, only external evidence.**
