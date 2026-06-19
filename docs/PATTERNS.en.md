# Engineering patterns · pitfalls we hit

> 中文版: ./PATTERNS.md

Most of these aren't part of the engine core — they're the traps we hit, repeatedly, building this whole thing (the engine itself plus its surfaces: a chat endpoint, the wake daemon, push, a dashboard). The first four sections are the LLM-surface plumbing layer (prompt caching / retry / credentials / utility calls); the rest are the broader engineering surface — engine, database, retrieval, build, time. One bottom line runs through all of it: **trust no claim, only external evidence** — whether the cache hit is in the token counts, whether the SQL is right is on a real DB, an audit finding is real once you reproduce it.

## 1. Prompt caching: savings come from the prefix, not the marker

**The one invariant: caching is a prefix match. Change any byte in the prefix and everything after it is invalidated.** Render order is fixed `tools → system → messages`; the cache key is the exact bytes up to each `cache_control` breakpoint.

### The rule: stable first, volatile last

Put the **unchanging** content first (persona / principles / long-lived memory / a fixed tool list) and mark it with `cache_control`; put the **per-turn** content (timestamps, a git commit, this turn's activity, request-varying ids) **after the last breakpoint**.

> ⚠️ **The most common silent trap.** A changing identifier (a timestamp / git commit hash / "current mode") sitting inside the cached prefix *and ahead of the history* — the moment it changes, it **cascades** and invalidates the entire history cache behind it. You re-write tens of thousands of tokens every turn while believing the cache is working. Fix: move those volatile fragments into the **last user message**, so the prefix (persona + history) holds a long-lived cache_read.

### Multi-turn

Put the breakpoint on the last content block of the **most recent message** — the prefix is stable + the whole history, accruing hits turn over turn. Give the long-lived persona its own breakpoint as well.

### A sliding history window breaks the cache by itself

The common "load the last N messages" makes the **oldest row drop out each turn**, so the prefix shifts and forces a full re-write every turn — same disease as the volatile-prefix one above, different cause. Fix: anchor history **append-only from the session start** (append by `sinceTs`) so the prefix is stable; only trim from the oldest end under a hard safety cap.

### Measure — don't trust the marker

A marker ≠ a hit. Read `cache_read_input_tokens` on the response: if it stays **0** across requests with an identical prefix, you have a silent invalidator (`Date.now()` in the system prompt, unsorted JSON, a varying tool set). **Diff the rendered bytes of two requests to find it.** This is the repo's whole stance: trust no claim, only external evidence.

### TTL

`{type:"ephemeral"}` is 5 minutes by default; for long-lived, gap-accessed content like a persona, use `{type:"ephemeral", ttl:"1h"}`. The economics: writes cost more than reads (≈1.25× for 5min / ≈2× for 1h), reads ≈0.1× — 5min breaks even at two requests, 1h needs three. Rolling history → 5min; stable persona → 1h.

### Constraints that bite

- At most **4** breakpoints per request.
- The minimum cacheable prefix is model-dependent (commonly 1k–4k tokens); below it, the prefix **silently won't cache** (`cache_creation` = 0, no error).
- **20-block lookback**: a breakpoint walks back at most 20 content blocks. An agentic turn that adds > 20 tool_use / result blocks won't find the previous cache and silently misses — add an intermediate breakpoint every ~15 blocks in long turns.
- **OpenAI-compat endpoints (OpenRouter etc.)**: don't put `cache_control` directly on the tools array (it 400s); put it on the system message — one breakpoint covers tools + system + history. Read usage from the right JSON path too — a provider nests cached tokens at e.g. `usage.prompt_tokens_details.cached_tokens`; read the wrong path and you'll see 0% hit all day.
- Don't change tools / switch model mid-session: tools render at position 0, so any change rebuilds the whole cache; caches are model-scoped.

### Cost: two money traps beyond caching

- **Reconcile your price table against live rates.** A hardcoded per-token price table that's a generation stale inflates all reported spend several-fold — the token counts are right, the multiplier is old. Check against the provider's models API; backfill historical rows (keep the old value in a column for rollback).
- **Move per-item LLM sweeps off the hot path.** Running an LLM evaluation on every wake / event can burn hundreds a month; a week's evidence doesn't change within a day, so a single daily cron cuts it to cents.

### Why caching doesn't violate "no auto-consolidation"

Caching is plumbing that saves money on a **disposable transcript buffer** — it doesn't summarize, draw conclusions, or claim what the conversation "was." That's different from auto-compaction / auto-summarization (which *does* render a compressed judgment about what the conversation was). The first is neutral — do it fully; the second carries a judgment and this repo doesn't do it (see the curation stance in [AUTONOMY.en.md](./AUTONOMY.en.md) — context is rebuilt from curated memory + reentry, not from an auto-summarized transcript).

## 2. Retry / timeouts / resilience

**Prefer the official SDK.** The Anthropic SDK auto-retries connection errors / 408 / 409 / 429 / ≥500 with exponential backoff, and honors `retry-after` — you don't write any of it.

**If you raw-fetch an OpenAI-compat endpoint** (OpenRouter etc., where you don't get the SDK's retries), a hand-rolled version must:

- **Exponential backoff + jitter** (not linear; jitter stops a batch of simultaneously-woken requests from retrying in lockstep and colliding again).
- **Honor the `Retry-After` header** (429 / 503 often carry it — the server tells you how long to wait; don't guess).
- **Branch on status**: retry 429, 5xx, and **529 overloaded** (all retryable); **don't** retry 4xx (400 / 401 / 403 — retrying won't help).
- Cap the attempts + an overall timeout.

**Tier your timeouts.** A generic fetch default (say 60s) is fine for ordinary APIs but will **abort a slow LLM generation** — extended thinking / long output can run two or three minutes. Give the LLM caller its own much-higher per-attempt timeout (180s range), so the retry machinery doesn't kill a slow response.

**Wrap every external call in a retry helper.** A bare `fetch()` to an upstream means a single `ETIMEDOUT` / `ECONNRESET` crashes the cron or surfaces as a tool error; route all through `fetchWithRetry`, with an explicit `res.ok` throw where the upstream has no structured error. Same for outbound webhook / notification sends — a retry queue so a network blip doesn't drop the message.

**Treat pool exhaustion as a transient to retry.** When several services share one session-mode pooler (low connection ceiling), queries **silently return empty** rather than erroring. Wrap each parallel query (tolerate a single empty result) so one rejection in a `Promise.all` doesn't 500 the whole dashboard; retry transient connection errors 3×; the real fix is a transaction-mode (pgbouncer) pooler + a higher connection ceiling.

**Long-idle SSE streams get killed by client body timeouts.** An idle SSE connection dies after ~5 min because the client's (undici) `bodyTimeout` fires with no data. Emit a periodic SSE comment (`: keepalive`) every ~25s, and `clearInterval` on close to avoid a timer leak.

**Different surface, different policy**: an interactive chat endpoint can just throw and let the user resend; a background / cron path (wake / digest) should back off and retry — don't let one scheduled tick lose a whole cycle to a transient outage.

## 3. Credentials / secrets / auth

**Fail closed on config — ship no default.** Never `process.env.X || "some-default-key/model/endpoint"` — if it's unset, error clearly at startup and exit, rather than silently running on an endpoint / model / key the user never chose. A missing API key should be a hard startup failure, not a silent open door.

**Import your env loader at every entry point.** Crons / scripts that crash on `DATABASE_URL not found` or a missing key are usually just an entry file that didn't `import "dotenv/config"` while a shared module assumed env was loaded. Load it in each entry point.

**Compare secrets in constant time.** Don't validate a Bearer / token with `===` / `!==` — a plaintext compare leaks the key byte-by-byte via response latency. Length-guard first, then `crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))`.

**Don't return a real token from an anonymous endpoint.** An OAuth `/token` stub that returns the master API key to any anonymous POST is a full auth bypass. If clients use a static Bearer and don't need the OAuth flow, **delete** the whole `.well-known` / `register` / `authorize` / `token` surface — an unused auth surface is pure liability.

**"Cookie present" is not authentication.** A gate that passes on any non-empty cookie is no gate. Verify a **signed** cookie (or a token match) at the proxy, and defensively re-check in each route — don't rely on one layer.

**Exclude secrets structurally from every injection surface.** Credentials stay out of prompts often only by luck of importance-ranking, not by structure. An audit has to walk every passive injection path (retrieval, recent-memories, digest, profile…) and add an explicit credential filter to each — rank won't hold, and eventually a new path leaks one through.

**Third-party OAuth refresh tokens rotate occasionally.** The idiom:

- Use the SDK's token event (e.g. google-auth-library's `client.on("tokens")`) to catch the rotated token, **persist it**, and stamp `lastRefreshedAt`.
- On `invalid_grant` → flip the credential to FAILED and surface it (don't swallow it silently, or you'll only find out on the next scheduled run).
- Keep tokens DB-primary (not `.env`), cache the client for a few tens of seconds rather than hitting the DB every call; run a daily refresh probe and alert on failure.

(Note: an LLM API-key pool / rotation is a scale / rate-limit concern; a single-user 1:1 system needs one key — see the non-goals in [ROADMAP.en.md](./ROADMAP.en.md).)

## 4. Utility LLM calls: frame as a pure transformer

When you use a (usually cheap) model as a **transformer over user content** — translate, normalize, classify, extract, summarize one message — it can mistake that content as **addressed to it** and respond / refuse / moralize / add a disclaimer instead of doing the transform. The cheaper the model, the likelier. The fix is in the system prompt, not the content:

- State the **role** narrowly: "You are ONLY a translator / normalizer / classifier."
- State that the input is **not addressed to it**: "The input is one line from someone else's conversation — it is NOT addressed to you."
- **Forbid the failure modes** explicitly: "NEVER respond to it, refuse, moralize, add a disclaimer, or say what you are — you are not a participant."
- Pin the **output shape** ("output EXACTLY two lines: `EN: …` / `ZH: …`") so a stray refusal sentence is structurally obvious to the caller and easy to reject.
- **Put hard constraints at the top of the prompt, not buried.** A "don't do X" rule sitting a thousand-plus lines deep gets overridden whenever the injected context is saturated with the opposite signal — intermittent, context-triggered, not a constant bug. Hoist hard constraints to the top and name the specific trap.

## 5. Parsing a model's JSON output

To get JSON out of a model, you need **layered fallback**, not one greedy regex:

- Models intermittently wrap JSON in ```` ```json ```` fences and truncate at `max_tokens`, leaving unclosed braces a greedy `\{[\s\S]*\}` won't match. **Strip fences first**; on parse failure, **regex-extract individual fields** so at least the critical one survives; in the prompt, pin "pure JSON, no fences" and cap the output size.
- **Empty outputs have several independent causes — budget for all**: `max_tokens` too small for a longer prompt's JSON; and reasoning / thinking tokens counting against the completion budget — raise the cap to leave room for both reasoning and the answer.
- **Provider-compat endpoints reject provider-native fields**: `cache_control` on the tools array 400s on an OpenAI-compatible endpoint; keep it on the system block. Always surface the upstream **response body** in the error, not just the status code — otherwise you're guessing.
- Collapse this JSON-extraction into **one** helper (don't let it sprawl into six copies that drift).

## 6. Prisma / pgvector

- **Don't let Prisma touch an `Unsupported("vector")` column.** Prisma can't deserialize a pgvector column; a default `findMany` / `create … RETURNING *` still SELECTs it and throws — and `create` throws first, masking that all reads are broken too. `omit` won't save you (`Unsupported` fields aren't exposed to the client). Approach: **declare** the column in the schema (so `db push` doesn't DROP it as an unknown column), but route all vector read/write through `$queryRaw` / `$executeRaw`. **Never `prisma db push --accept-data-loss`** — it silently drops columns it doesn't know about (that's how a whole table of embeddings got lost).
- **Quote camelCase column names in raw SQL.** `@@map` maps the table name only; column identifiers stay as declared (`isActive` / `topicId`). Postgres lowercases unquoted identifiers, so an unquoted `is_active` raises `42703 undefined column`.
- **A deployed Prisma client lagging a new enum value crashes every full-column read.** Add an enum value to the DB without regenerating the client and any query returning that enum column throws `Value X not found in enum`, silently killing background loops. Two defenses: read display rows via `$queryRaw` + `"col"::text` (unknown values can't poison the result); add a `postinstall: prisma generate`. Note `git pull` + restart does NOT run install, so a manual `db:generate` step is still needed.
- **Index graph / link tables on both traversal directions.** A links/edges table walked by `from` and `to` ends needs a composite index on each (`[fromType,fromId,relationType]` and `[toType,toId]`); add them before the edge count grows. Build with `CREATE INDEX IF NOT EXISTS` using Prisma's naming so `db push` doesn't re-detect.
- **Don't proxy a real condition with a correlated-but-not-equivalent column.** A dashboard counted "missing embeddings" via `embeddingAt IS NULL`, but a row can have a vector and a null timestamp — overcounting missing by 180-odd while the true `embedding IS NULL` count was 0. Query the condition you actually mean.

## 7. Migrations / schema evolution

- **Don't rely on `prisma db push` when the pooler is connection-constrained.** A 15-connection Supabase pooler with processes already running makes `db push` fail (`EMAXCONNSESSION`). Writing `ALTER TABLE … ADD COLUMN IF NOT EXISTS` into a checked-in SQL file run via one `psql` does schema + backfill reliably.
- **Make migrations idempotent and check them into the repo.** Use `ADD COLUMN IF NOT EXISTS`; flag row-specific backfill UPDATEs as non-idempotent historical artifacts that fresh installs skip. Migrations applied by hand and never committed are time bombs.
- **Leave the consumer a fallback when you add a column.** A new nullable column feeding a size-bounded context (summary vs full content) wants a `slice()` fallback + a warning rather than a hard block — so old rows the consumer hasn't been updated for don't all break.

## 8. Retrieval / eval

- **A semantic-only search needs a similarity floor — tuned from measured data, not guessed.** Base embedding similarity (notably for CJK text) is high enough (~0.3–0.5) that unrelated queries pass a low final-score cutoff and return random neighbors. Measure the **gap** between "unrelated" and "truly similar" scores on a real eval set and set the floor in the gap; an over-high floor (0.5) silently drops genuine matches scoring 0.43–0.49. Strong keyword / entity hits should **bypass** the floor.
- **Stand up the eval harness (nDCG / hit@k + a regression alert) before tuning thresholds.** Build the measurement first; run it on a cron, compare to a rolling average, alert on a drop — so threshold tuning is data-driven and regressions are caught automatically.
- **Only put cases your data can actually satisfy into the eval set.** "Failures" that are really missing source data (no memory body contains the term) should be removed, not treated as algorithm bugs; don't pad the set with cases you can't ground. Negative controls (`expectNone`) are their own class — keep them out of the headline hit@ / MRR.
- **Re-embed on edit, not just on null.** A sweep that only embeds NULL-vector rows leaves stale embeddings after content edits; stamp an `embeddingAt` and re-embed when `updatedAt > embeddingAt`. Size the sweep batch so a backfill finishes in one run, not over days.

## 9. Data modeling / dedup / defaults

- **A schema `@default` silently enrolls records into expensive processing.** Three create-paths never passed a `resolution`, so a `@default(OPEN)` pulled dozens of routine rows into a continuous LLM sweep pool — hundreds a month. Set the field **explicitly** at every write site, backfill the mis-defaulted rows, and give the rare true cases a reopen tool.
- **Pick a dedup key that's stable and free of glitchy fields.** Keying on an internal id breaks when grouping changes; keying on a noisy upstream timestamp produces duplicate notifications when the source re-emits the same item. Use a stable natural key (date + content); key user-facing dedup on the slug / identity, not the timestamp — keep the timestamp only on the underlying full-history record.
- **A "only new since last run" clause permanently strips a backlog.** A `createdAt >= since` filter on pending items means anything skipped by a per-run cap is **never retried** (its `createdAt` predates the next `since`). Drop the time filter and rely on slug-based dedup (e.g. 48h) to prevent re-sends while still retrying stuck items. For gappy event streams, a **fixed look-back window** (e.g. 12h) beats "since last success" — the latter misses signals that landed during a suppressed / skipped window.
- **A single-row upsert keyed on type silently overwrites another.** A state write keyed only on type lets one record quietly replace another of the same type; key the upsert on `(type, title)` so distinct items coexist.
- **DRY drift becomes a correctness bug.** Cross-surface contracts (event-type names, parse logic, tool schemas) duplicated in two places drift: two transport entry points (stdio vs SSE) each missing tools the other had, same-named tools with mismatched schemas (one took a slug, one an id), one even leaking keys the other filtered; a daemon writing one eventType while the reader queries another → commits silently invisible. Extract cross-surface contracts into **one** registry / module and change it once.
- **An ASCII-only slugify drops CJK.** A slugify that assumes ASCII strips a Chinese identity key to an empty string and downstream key-aggregation breaks. Keep slugify Unicode-aware, or handle non-ASCII explicitly.

## 10. Time / timezone

- **Inject "now" into any LLM context that reasons about time.** Without a "now" header the model **infers** current time from event timestamps and gets intervals / relative times wrong; pass an explicit `current: YYYY-MM-DD HH:MM`, and the **weekday** too (models infer day-of-week unreliably).
- **Event time ≠ write time.** A record's `createdAt` (write time) is not the time of the thing it describes; ground temporal reasoning in event time and add a **freshness gate**, or days-old conversation gets quoted as current presence.
- **One timezone source of truth = an IANA zone, not an offset.** Storing a numeric UTC offset and doing time math breaks across DST; store an IANA zone (e.g. `Asia/Shanghai`), defined once, used everywhere.
- **A timestamp-stripping regex must cover every separator the producer might emit.** A strip filter that only matched hyphen dates leaked prefixes when the producer switched to slashes; use a `[-/]` character class — teach the pattern rather than enumerate formats.

## 11. Concurrency / cron / serverless / agent safety

- **Don't fire-and-forget writes in serverless.** Vercel / serverless kills the instance after `controller.close()`, so an un-awaited `void prisma.create(...)` never lands; `await` writes before closing the stream.
- **Add `timezone` to every cron schedule.** A cron expression without `{ timezone: "Asia/Tokyo" }` runs in the host's zone and fires at the wrong local hour.
- **Bound the agentic loop + gate concurrent jobs.** Cap agent turns (`maxTurns`) with an explicit "stop when you've gathered enough" instruction; put a concurrency lock on hourly ticks so overlapping runs don't double-process.
- **Self-heal scheduled jobs with a watchdog + startup catch-up.** A stale client made a twice-daily briefing silently stop for ~9h with no alarm. Add a watchdog cron that detects a missed slot (past grace, no event since) and restarts the worker, plus a startup catch-up that delivers a genuinely-missed slot once — guarded so routine restarts after a successful slot don't re-fire.
- **`allowedTools` is a pre-approval list, not a whitelist.** Tools not listed are **still callable** and fall through to the permission mode. To actually restrict an autonomous agent, set a deny-by-default permission mode **and** add a programmatic `canUseTool` gate.
- **`setState` updaters are deferred, not synchronous.** Mutating an outer `let` inside a React 18 `setState((s) => …)` updater and reading it before commit — the value is still empty when `fetch` runs, sending an empty payload. Compute the next value synchronously with a plain `const`, not in the updater body.

## 12. Build / CI / dependencies

- **A lockfile is platform-specific.** A lockfile generated on macOS misses Linux's native optional deps (esbuild / tsx's `@emnapi/core` and friends), and CI then fails `npm ci` on the Linux runner. Use `npm install` in CI, or generate a multi-platform lockfile — `npm install --package-lock-only` on a single OS won't capture other platforms' optionalDependencies.
- **Run `prisma generate` before the build on CI.** Missing `@prisma/client` types fail the build until generate is wired into the build step; also declare the env vars you use in `turbo.json` and set `packageManager` at the repo root for workspace resolution.
- **Don't depend on the CI runtime stripping TS for you.** A build that runs `node script.ts` assuming native TS strip breaks when the CI Node version (22.x) doesn't strip and there's no `.nvmrc` / `engines` pin. Make the hook fail-soft (a committed fallback artifact) and pin the Node version.
- **Static review systematically over-claims.** Static inference hunting bugs over-claims systematically; an audit finding is to be trusted once you **reproduce it behaviorally** (run it once in a real environment). The repo's self-audit harness exists for exactly this — which is why verifying DB-bound paths means starting a real DB and running, not just tsc + unit tests.

## 13. Observability

- **Always log "I ran, here's what I saw" — not only "I did something."** A poller that logs only when it adds rows makes a silent zero-result run indistinguishable from not running; emit a per-run `checked N · added N · skipped N`. Add temporary verbose `debug:` logging to diagnose why an upstream returns nothing, then revert once you've found the root cause.
- **On total failure, write an explicit audit / fallback marker instead of nulling.** A scoring call that returns null writes nothing and leaves a silent gap in a timeline; write a `*_failed` audit row (and retry once) so the gap is visible and recoverable. Surface the upstream error body in client-facing errors, not a bare status code.

## 14. Third-party APIs / scraping

- **Rate-limit, jitter, and rotate when scraping a consumer platform, or the account gets flagged.** Up to ~hundred requests/day plus precise cron timing got an account warned / banned for "excessive AI use"; add a shared daily cap, reuse a session cache, jitter the cron to break its fingerprint, rotate query targets, and back off further on a warning.
- **Private-repo webhook / API payloads omit fields public ones include.** GitHub returns an empty `payload.commits` for private repos; a `if (commits.length===0) continue` drops everything. Fall back to a secondary API (the compare endpoint) and always emit a marker — a failed enrichment still leaves a record.
- **Prefer the cheapest API format that has the field you need, and verify version compat.** A `format=metadata` Gmail call raised `invalid_request` on the deployed googleapis version; `format=minimal` both worked and was cheaper when only `threadId` was needed. For multipart email, walk parts recursively and prefer HTML when the text/plain part is a near-empty placeholder.
- **Scrape from a stable structured source, not best-effort HTML.** Title / body extraction via HTML regex returns a random element (often a comment, not the body); pull the token / id from the URL query and call the structured detail API.

## 15. Frontend surfaces: PWA / Electron

- **Don't serve page HTML stale-while-revalidate.** A service worker caching navigation HTML stale-while-revalidate serves a stale theme / state and refreshes only in the background after the user has already navigated past. Use **network-first** for navigation / document requests (cache only as offline fallback), stale-while-revalidate for data / RSC; bump the SW version to flush old HTML. Handle iOS Safari's bfcache separately — a `pageshow` listener that reloads on a cookie / state mismatch.
- **Persist Electron window position / size by viewport ratio, not absolute pixels.** Absolute pixels don't line up across different window sizes / maximize; store the viewport ratio so restore is stable. Clamp drag / restore to bounds so the title bar can't hide behind the menu bar, and give a double-click-title reset.
- **Strip personal references before open-sourcing — and freeze it into a test.** Strip names / brand / private words out of the code before you open it; better, keep a scanner (this repo's `npm run scrub`) that blocks private residue from reaching a commit, rather than relying on remembering.

## A note on consistency

These are engineering references, not part of the engine; adapt them to your stack when they land in your fork. There's only one bottom line, and it runs through all of it: **trust no claim, only external evidence.**
