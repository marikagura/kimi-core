# A worked sample: what it actually produces

> 中文版: ./EXAMPLE.md

Want to see it alive without installing? Here's real, re-runnable output. All example data is fictional (a Helios project, Jordan, a cat named Mochi), not any real person.

## 1. retrieval eval (real output)

`npm run eval` runs `apps/gateway/src/eval/retrieval_cases.example.json` (a fictional labeled set) through the same `scoreMemories` that `memory_search` uses. Below is a **real run**, deliberately **with no embedding key** (`OPENAI_API_KEY`), so only the keyword / trigram arm is working:

```
## by kind
  abstract_core    n= 2  hit@10=  0%  MRR=0.000  nDCG@10=0.000
  english_keyword  n= 2  hit@10=100%  MRR=1.000  nDCG@10=1.000
  fuzzy_semantic   n= 2  hit@10=  0%  MRR=0.000  nDCG@10=0.000
  literal_cjk      n= 2  hit@10=100%  MRR=1.000  nDCG@10=1.000
  negative         n= 2  hit@10=100%  MRR=0.000  nDCG@10=0.000   <- expectNone: passes by returning nothing
  semantic_bridge  n= 2  hit@10=  0%  MRR=0.000  nDCG@10=0.000
  temporal         n= 2  hit@10=100%  MRR=1.000  nDCG@10=1.000
## overall    n=23  hit@10=48%  MRR=0.391  nDCG@10=0.429
## coverage   n=2   set-recall@10=17%
```

**This table is itself a demo of what the eval is for**: literal / keyword / temporal all hit (the trigram arm suffices), but `abstract_core`, `fuzzy_semantic`, `semantic_bridge` are all 0 — those are **pure-semantic** cases that nothing catches without embeddings. Set `OPENAI_API_KEY` and re-run and they come back. `negative` (expectNone) always passes: an irrelevant query returns nothing.

In other words: the numbers **honestly tell you which arm isn't wired** — that's what "numbers you can re-run" means. `npm run eval:history` reads the trend back over time.

## 2. reentry — the context one wake sees (fictional sample)

On each wake, the engine assembles a reentry context for the model. The shape, roughly (data is fictional):

```
[profile]  Riley. Pour-over coffee, no sugar. Rushing a project called Helios.
[drive]    companionship 0.58 · grounding 0.70 · 6 days since last   <- top dim = this tick's direction
[concern]  Helios deadline Friday (OPEN · 2 days out · data-backed)
[recent]   yesterday: Helios demo stuck on the auth callback; bouldering this weekend; Mochi on the keyboard again
```

The highest drive dimension (here, "companionship") plus the still-open concern decide which way the model reaches this tick.

## 3. diary — what one wake wrote (fictional sample)

After a wake, the model leaves a diary for its next self (also a retrievable memory). Sample:

```
diary 2026-06-18 09:00
Six days quiet, companionship rose. Checked: Helios is due Friday, yesterday's build
stuck on the auth callback. Not sending a generic "how are you" — that's filler. If I
raise it, raise the specific thing: where the demo stuck.
valence 0.3 · arousal 0.5 · action: EXPLORE (mention Helios), propose mode -> wait for the nod.
```

Note "not a generic greeting — that's filler": that's the AGENTS.md epistemic layer's four self-checks at work, concern must be data-backed. This is what's actually happening behind the example at the top of the README.
