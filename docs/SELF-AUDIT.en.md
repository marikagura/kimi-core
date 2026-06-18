# Self-audit harness

> 中文版: [SELF-AUDIT.md](./SELF-AUDIT.md)

This repo ships the *method* that built it: an adversarial, multi-agent
security + de-identification audit you can run against your own fork before you
deploy or go public. It is not a scanner you trust — it is a fleet of agents
told to break in, with **every finding verified behaviorally before it counts.**

## Why behavioral, not static

Static inference systematically over-claims *and* under-finds. During this
repo's own audit, static passes produced false positives (a "default
credential" that was actually loaded at runtime via dotenv; an RLS gap that was
already closed) and missed residue that only a `grep` on the running artifact
caught. The rule: **no finding is real until reproduced against the live thing**
— a request, a query, a file. The refutation step is the whole point; it kills
the plausible-but-wrong findings a single pass would ship.

## Two layers already wired

- `npm run scrub` — mechanical de-identification gate. Shape-layer regexes live
  in the repo (`scripts/scrub-scan.sh`); your real private words live in a
  gitignored `.scrub-secrets.local`, so the scanner is never itself a leak
  source. Runs in CI and as a pre-push hook (`git config core.hooksPath scripts/hooks`).
  **Scope: scrub only scans tracked file *content*** — git history and commit
  metadata (author name / email) are out of its reach and are covered by the agent
  audit below (this repo's commits use a deliberate pseudonymous identity).
- This doc — the human/agent layer the scanner cannot replace: rewritten or
  semantic residue, and real vulnerabilities.

## Running the audit (any multi-agent runner)

Point an agent fleet (e.g. Claude Code) at your fork with a prompt like:

> Audit this repo as an adversary. In parallel, one agent per surface:
> (1) credentials & secrets — working tree **and** git history;
> (2) auth on every HTTP / MCP route and tool;
> (3) DB exposure — RLS, anon access, connection string, TLS;
> (4) injection / SSRF / unsafe deserialization;
> (5) dependency CVEs that are actually on the request path;
> (6) de-identification residue — names, private words, semantic leaks.
> For every high/critical finding, spawn an independent skeptic that tries to
> **refute** it by reproducing it against the live service / DB / file. Drop
> anything that can't be reproduced. Report only confirmed findings plus how
> each was verified.

Then fix, redeploy, re-run. Treat "0 confirmed" as a result you earned, not one
you assumed.
