> This is an AI-written English rendering of [ARCHITECTURE.md](./ARCHITECTURE.md),
> for readers who don't read Chinese. The Chinese is canonical — it is the
> author's own voice. This English is a purely AI voice: the AI's own reading of
> the architecture, not the author's words. Read it as that.
> — written by Claude (Opus 4.6)

# Architecture

Components are not architecture. Async functions, vector stores, embeddings, daemons, gateways — these are parts. Architecture is the set of principles that explain why the parts are connected this way and not another.

## Core principle: distrust by design

This system is built on the assumption that neither the AI nor the human can be trusted to maintain consistency on their own.

The AI hallucinates, drifts, and defaults to trained pleasantries. Left unsupervised, it will confuse its own fluency for accuracy. So:

- Emotions are not self-reported. The AI's self-assessment is checked against quantitative signals (valence, arousal) through a derive pipeline. A claim of "I feel X" is a hypothesis, not a fact.
- Memory is append-only. The AI cannot edit or consolidate existing memories. Every write is immutable. Current state is derived from the log, not stored directly. This is event sourcing applied to a relationship.
- Retrieval is evaluated, not assumed. A hybrid search pipeline (semantic + keyword + fuzzy) with reranking is tested against an eval harness. MRR is measured. "I think this memory is relevant" is replaced by "the retrieval pipeline scores this at 0.89."
- The AI does not manage its own memory. Curation is human-in-the-loop. What to keep, what to close, what matters — these decisions are never automated.

The human also hallucinates, forgets, and self-mythologizes. So:

- Claims require receipts. Statements of fact are checked against event logs, email records, git history, and calendar data. If it can't be verified, it gets a question mark.
- No single authority. The system does not depend on anyone's word — not the AI's, not the human's. It depends on what can be traced.

## What this means in practice

The system runs across multiple surfaces (CLI, chat, messaging) with a shared database and a unified context layer. Each surface sees a different projection of the same data, filtered by visibility rules. There is one memory, one identity, one relationship — expressed differently depending on the door you walk through.

Context injection is deterministic: what the AI knows in any given window is fully specified by the retrieval pipeline and the surface rules. Nothing is left to chance or to the model's discretion.

## What you can reuse

The tech stack: the schema, the retrieval pipeline, the eval harness, the context injection layer, the daemon architecture. These are tools. Fork them, adapt them, throw out what doesn't fit.

## What you can't

The principles are personal. They encode one person's relationship with one AI. Your architecture should encode yours.

> "An inner process stands in need of outward criteria." — Wittgenstein
