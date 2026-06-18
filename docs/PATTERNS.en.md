# Engineering patterns · prompt caching / retry / credential rotation

> 中文版: ./PATTERNS.md

These aren't part of the engine — they're the few things you have to get right, repeatedly, when wiring an LLM surface (a chat endpoint, the wake daemon, push). All battle-tested; caching especially, where the traps are **silent** — you won't find them without measuring.

## 1. Prompt caching: savings come from the prefix, not the marker

**The one invariant: caching is a prefix match. Change any byte in the prefix and everything after it is invalidated.** Render order is fixed `tools → system → messages`; the cache key is the exact bytes up to each `cache_control` breakpoint.

### The rule: stable first, volatile last

Put the **unchanging** content first (persona / principles / long-lived memory / a fixed tool list) and mark it with `cache_control`; put the **per-turn** content (timestamps, a git commit, this turn's activity, request-varying ids) **after the last breakpoint**.

> ⚠️ **The most common silent trap.** A changing identifier (a timestamp / git commit hash / "current mode") sitting inside the cached prefix *and ahead of the history* — the moment it changes, it **cascades** and invalidates the entire history cache behind it. You re-write tens of thousands of tokens every turn while believing the cache is working. Fix: move those volatile fragments into the **last user message**, so the prefix (persona + history) holds a long-lived cache_read.

### Multi-turn

Put the breakpoint on the last content block of the **most recent message** — the prefix is stable + the whole history, accruing hits turn over turn. Give the long-lived persona its own breakpoint as well.

### Measure — don't trust the marker

A marker ≠ a hit. Read `cache_read_input_tokens` on the response: if it stays **0** across requests with an identical prefix, you have a silent invalidator (`Date.now()` in the system prompt, unsorted JSON, a varying tool set). **Diff the rendered bytes of two requests to find it.** This is the repo's whole stance: trust no claim, only external evidence.

### TTL

`{type:"ephemeral"}` is 5 minutes by default; for long-lived, gap-accessed content like a persona, use `{type:"ephemeral", ttl:"1h"}`. The economics: writes cost more than reads (≈1.25× for 5min / ≈2× for 1h), reads ≈0.1× — 5min breaks even at two requests, 1h needs three. Rolling history → 5min; stable persona → 1h.

### Constraints that bite

- At most **4** breakpoints per request.
- The minimum cacheable prefix is model-dependent (commonly 1k–4k tokens); below it, the prefix **silently won't cache** (`cache_creation` = 0, no error).
- **20-block lookback**: a breakpoint walks back at most 20 content blocks. An agentic turn that adds > 20 tool_use / result blocks won't find the previous cache and silently misses — add an intermediate breakpoint every ~15 blocks in long turns.
- **OpenAI-compat endpoints (OpenRouter etc.)**: don't put `cache_control` directly on the tools array (it 400s); put it on the system message — one breakpoint covers tools + system + history.
- Don't change tools / switch model mid-session: tools render at position 0, so any change rebuilds the whole cache; caches are model-scoped.

### Why caching doesn't violate "no auto-consolidation"

Caching is plumbing that saves money on a **disposable transcript buffer** — it doesn't summarize, draw conclusions, or claim what the conversation "was." That's different from auto-compaction / auto-summarization (which *does* render a compressed judgment about what the conversation was). The first is neutral — do it fully; the second carries a judgment and this repo doesn't do it (see the curation stance in [AUTONOMY.en.md](./AUTONOMY.en.md) — context is rebuilt from curated memory + reentry, not from an auto-summarized transcript).

## 2. Retry / backoff

**Prefer the official SDK.** The Anthropic SDK auto-retries connection errors / 408 / 409 / 429 / ≥500 with exponential backoff, and honors `retry-after` — you don't write any of it.

**If you raw-fetch an OpenAI-compat endpoint** (OpenRouter etc., where you don't get the SDK's retries), a hand-rolled version must:

- **Exponential backoff + jitter** (not linear; jitter stops a batch of simultaneously-woken requests from retrying in lockstep and colliding again).
- **Honor the `Retry-After` header** (429 / 503 often carry it — the server tells you how long to wait; don't guess).
- **Branch on status**: retry 429, 5xx, and **529 overloaded** (all retryable); **don't** retry 4xx (400 / 401 / 403 — retrying won't help).
- Cap the attempts + an overall timeout.

**Different surface, different policy**: an interactive chat endpoint can just throw and let the user resend; a background / cron path (wake / digest) should back off and retry — don't let one scheduled tick lose a whole cycle to a transient outage.

## 3. Credential rotation (OAuth refresh tokens)

Third-party OAuth (Google etc.) rotates refresh tokens occasionally. The idiom:

- Use the SDK's token event (e.g. google-auth-library's `client.on("tokens")`) to catch the rotated token, **persist it**, and stamp `lastRefreshedAt`.
- On `invalid_grant` → flip the credential to FAILED and surface it (don't swallow it silently, or you'll only find out on the next scheduled run).
- Cache the client for a few tens of seconds — don't hit the DB on every call.

(Note: an LLM API-key pool / rotation is a scale / rate-limit concern; a single-user 1:1 system needs one key — see the non-goals in [ROADMAP.en.md](./ROADMAP.en.md).)
