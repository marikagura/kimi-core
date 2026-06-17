# Autonomy layer

> 中文版: [AUTONOMY.md](./AUTONOMY.md)

This document is the architecture argument for the autonomous-agency layer — the
part of the engine that decides, on its own clock, whether to surface anything at
all and what to surface. It is an engineering-grade marker, not a manifesto: it
states plainly what is **standard** in the literature, what is the **niche
combination** this layer happens to occupy, and — most importantly — the
**fault lines** where this layer *approaches* motivational autonomy without
arriving at it.

The governing honesty of the whole document is one phrase: **逼近不是到达** —
*approaching is not arriving.* Every claim below is scoped against that.

---

## 1. The mechanism

The autonomy layer is a loop, not a feature. One cycle:

```
cron wake
  → read drive / concern / persona state
  → action selection  (acting is the normal case; DO_NOTHING is an available option, not evaluated first)
  → dispatch  (or abstain)
  → diary / self-score feedback
  → recalibration of drive & concern state
  → (next wake)
```

### 1.1 Wake — an external clock

A cron schedule fires the loop. There is no self-originated impulse here, and the
code says so: `intel.ts` registers `cron.schedule(DAILY_CRON, runAll)` plus an
hourly digest tick, and runs once immediately on boot. The wake is a timer pulse.
This is the direct technical lineage of MemGPT's `request_heartbeat` (Packer et
al., 2023, *MemGPT: Towards LLMs as Operating Systems*) — a flag the agent sets
to be re-invoked, whose origin is still "a regular schedule." The agent loop
itself is ReAct (Yao et al., 2022, *ReAct: Synergizing Reasoning and Acting in
Language Models*): a while-loop over tool calls. Both are standard. Naming the
timer a "heartbeat" is a biological metaphor over a scheduler; this document
refuses that metaphor.

### 1.2 Read drive / concern / persona

On wake the loop reads three things:

- **Drives** — `deriveDrives()` (`lib/concern-derive.ts`) computes, per
  dimension, a scalar `grounding × max(recency, want)`. `recency = exp(-d/τ)` is
  high right after an event; `want = min(1, d/scale)` is high after a long gap;
  their max gives a U-shape (high just-after, high after a drought, low in the
  middle). This is the positive, generative pole: *what does the system want to
  reach toward.* It is modeled on Panksepp's SEEKING system and on Berridge's
  wanting-vs-liking distinction (see §3): "afterglow" (liking) is deliberately
  removed from drive ranking and demoted to a separate hedonic scalar, because
  liking does not drive behavior — wanting does.
- **Concerns** — `deriveConcerns()` projects open negative-valence memory threads
  into active state. A concern carries a `resolution` (OPEN / EASING / RESOLVED),
  decays if untouched (`decayStaleConcerns`), is closed or reopened by an LLM
  sweep (`sweepConcerns`), and only re-emerges by a *new* OPEN record under the
  same key — never by reviving an old resolved row. This is the negative,
  maintenance pole.
- **Persona** — the forms of address, register, principles, and reflection rules.
  **This is not in the engine.** It is injected from a `persona.md` / `AGENTS.md`
  the user writes. See §5.

### 1.3 Action selection — DO_NOTHING as an option, not the default

Acting is the normal case. The users this layer is built for want to see the
agent *do* something — write, explore, reach out — so the loop is not biased
toward silence and does not evaluate "do nothing" first. What DO_NOTHING adds is
that **abstention is an available, legitimate action**, not an absent capability:
the agent *may* choose not to act, and when it does, the choice is recorded like
any other action.

That matters because the literature treats abstention almost entirely as a
*reliability knob* — see §2 — whereas including it as a real action treats the
ability to *choose not to act* as part of agency, not merely a way to avoid wrong
answers. The capacity is present and a full member of the action set; it is simply
not the default the loop reaches for.

A related conservatism does live deeper in the engine, and it is worth not
overclaiming: the self-sweep is told *"when unsure, linger"* and an
empty/unparseable verdict defaults to no-change rather than action; the dialogue
digest writes no row rather than a fake one when generation fails; drives below a
grounding floor do not stand up. That is caution against *false* action, not a
global bias toward silence in the wake loop.

The honest caveat, stated up front so it is not buried: **choosing not to act is
not choosing to act.** Reactive restraint (not firing when a trigger appears) is
genuinely here. Generative initiation (firing when nothing triggered) is the open
gap. See §2's closing distinction and §6.

### 1.4 Dispatch — HITL propose/auto knob

If selection yields an action, dispatch is gated by a human-in-the-loop knob:

- **propose** — the action is written as a candidate / pending item for the user
  to confirm. Nothing reaches the surface without a hand on it. The engine's
  curation path (`PendingItem`, append-only memory, no LLM auto-consolidation) is
  this stance generalized: *every fact about the user passes through the user's
  confirmation.*
- **auto** — the action dispatches directly (e.g. surfacing a drive onto a
  reentry view, sending a push) under pre-set rate and content limits.

The knob is per surface and per action type; the safe default is propose. The
companion-software literature is the reason this is a knob and not a feature you
turn on and forget (§4).

### 1.5 Diary-score feedback → recalibration

After acting (or not), the loop records a self-score: a per-session
valence/arousal snapshot written as a `SELF_SCORE` memory by the digest path.
These scores are the substrate the next wake reads:

- they age the drives (recency / want),
- they accumulate into concerns under a recurrence gate (weak negatives must
  recur across ≥ N days; a strong single negative stands up same-day),
- and they are **recalibrated against external feedback**: `recalibrateValence()`
  fits a monotonic offset from `(self-rating, user-rating)` pairs, correcting the
  system's systematic self-over-estimation. With too few samples it is the
  identity — it does not invent a correction it has not earned.

This closes the loop: the system's own read of how it went is *not trusted on its
face* — it is corrected by external evidence before it feeds the next cycle. That
discipline (trust neither the AI nor the user, only external evidence) is the
same one that governs the whole engine; see [ARCHITECTURE.en.md](../ARCHITECTURE.en.md).

---

## 2. DO_NOTHING — abstention as agency

**What is standard.** Abstention is a 55-year-old idea. Chow (1970), *On
optimum recognition error and reject tradeoff*, introduced the reject option:
a classifier may decline to decide. Modern selective classification inherits it
directly, and treats it as a reliability mechanism — a way to lower error by
answering less.

**The recent turn.** A cluster of 2024–2026 work reframes abstention as a
*capability* rather than a knob:

- Wen et al. (2024/2025), *Know Your Limits: A Survey of Abstention in Large
  Language Models* — frames abstention as a **meta-capability**.
- Kirichenko et al. (2025), *AbstentionBench* — finds reasoning-tuning **costs
  roughly −24%** on abstention: making models better reasoners can make them
  *worse* at declining to answer.
- Bonagiri et al. (2025), *Selectively Quitting* — names the **compulsion to
  act**: models are biased toward producing an answer.
- Sun et al. (2026), *When2Tool* — shows **knowing is not doing**: a model can
  internally detect that it should not call a tool (AUROC **0.89–0.96**) yet call
  it anyway. High discrimination, low follow-through.
- Yeke et al. (2026), *Yes-Man* — embodied agents refuse an unsafe/ill-posed
  instruction only **~16.5%** of the time.

**The claim of this layer.** Including DO_NOTHING as a real, available action —
rather than leaving abstention an implicit failure mode — moves "doing nothing"
from the reliability framing toward a constitutive one: the capacity to abstain is
treated as a property of agency, not just an error-avoidance trick. Acting remains
the normal case; what changes is that declining to act is an option the agent
owns. This positioning is the niche — most of the literature above measures
abstention as reliability and does not ask whether it is agency.

**The fault line — stated, not hidden.** Reactive restraint ≠ generative
initiation. *Not acting when triggered* is a different thing from *acting when
untriggered*, and only the former is fully realized here. The literature has no
clean criterion separating "chose not to do" from "chose to do" as distinct
agentive acts; that gap is real and this layer sits on the near side of it. **能
选「不做」≠ 能选「要做」.**

---

## 3. Self-drive — wanting, and the ignition gap

**What is standard.** Intrinsic motivation and autotelic RL have a 20–30-year
tradition; an information-theoretic curiosity reward (novelty / surprise /
empowerment) is not new. Citing it as "the system wants" would overclaim.

**The roots this layer actually uses.** The drive model is dual-rooted:

- *Neuroscience.* Panksepp (1998), *Affective Neuroscience*, describes primary
  affective systems (SEEKING, CARE, PLAY, FEAR, etc.); SEEKING is appetitive
  craving itself, not consummatory pleasure. Berridge & Robinson (2003),
  *Parsing reward*, separate **wanting (incentive salience) from liking
  (hedonic impact)** — they are dissociable systems. This layer takes that
  literally: the U-shaped drive is *wanting*; "afterglow" is *liking* and is
  pulled out of behavior-driving ranking. Davis & Montag (2019) provide the
  affective-neuroscience personality scales that operationalize Panksepp's
  systems as measurable dimensions.
- *Formal.* Colas et al. (2022), *Autotelic Agents with Intrinsically Motivated
  Goal-Conditioned RL* (JAIR 74), gives the autotelic framing: agents that
  represent and pursue their own goals. Schmidhuber (2010), *Formal Theory of
  Creativity, Fun, and Intrinsic Motivation*, gives the formal curiosity reward;
  Forestier et al. (2022), *Intrinsically Motivated Goal Exploration Processes
  (IMGEP)*, the exploration-process form.

**The fault line — ignition vs direction.** Self-drive shapes **where to go
after waking**, not **why to wake**. The cron supplies ignition; the drive
supplies direction. The engine cannot originate the first inference — it is
re-invoked, then chooses among reachings. A drive scalar tells the loop *which
dimension to reach toward once it is already awake*; it does not and cannot tell
the loop *to wake.* That is the precise boundary, and it is the boundary the
classical theory already named (§4).

**The curiosity caveat.** An AI curiosity reward is an information-theoretic
scalar. It is **not yet Berridge "wanting."** Treating a novelty bonus as
"the system wants" collapses exactly the distinction Berridge & Robinson drew.
This layer routes drive through the wanting/liking frame precisely to keep that
distinction visible, but routing it through the frame does not make the scalar
into wanting. It approaches; it does not arrive.

---

## 4. Honest positioning against the classical theory

The uncomfortable fact, named directly: the agentic boundary this layer presses
on was mapped in **1995**, and a great deal of current "agentic" work is
re-inventing that wheel.

- Wooldridge & Jennings (1995), *Intelligent Agents: Theory and Practice*, give
  the **weak agency four properties**: reactivity, pro-activeness, autonomy,
  social ability. Pro-activeness is defined as **"taking the initiative"** — not
  merely responding. This layer satisfies reactivity and parts of autonomy/social
  ability; it is *pro-activeness* — initiative that is genuinely untriggered —
  that remains the half-empty gauge.
- Luck & d'Inverno (1995), *A Formal Framework for Agency and Autonomy*, draw the
  line precisely: an **agent** pursues goals it is given; an **autonomous agent**
  generates its own goals. **The boundary is motivation.** By that taxonomy this
  layer is high in *executive* autonomy (it decides how and whether to act) and
  low in *motivational* autonomy (the goals — and the wake — come from outside).

Two contemporary points fix the position on a continuum, not a binary:

- Lu et al. (2024), *ProactiveBench* — even fine-tuned for proactivity, models
  reach only **F1 ≈ 66.47%**; and the proactivity measured there is
  *other-directed* (predict the user's need), not *self-originated* (the agent
  wants, for itself, to wake). Looking proactive is not the same as being
  pro-active in Wooldridge & Jennings' sense.
- Liu et al. (2025), *Inner Thoughts* (CHI) — the **nearest neighbor in the
  literature**: a model maintains a stream of inner thoughts and decides when one
  is worth voicing. It is the closest published analogue to a drive/threshold
  surfacing mechanism. It differs from this layer in that it is within-session
  and conversation-internal, does not connect to affective neuroscience, and does
  not treat do-nothing as an agency threshold.

**Closing position.** This layer **approaches** motivational autonomy. It does
not arrive. Stated as engineering: cron + Panksepp-rooted self-drive +
DO_NOTHING as a real action press toward three gaps the literature has left open
(motivational autonomy, autotelic *meta*-goals, ownership) — they press toward
them; they do not close them.

---

## 5. Curiosity as an action (web search)

One concrete positive action the loop can dispatch is an outward information
reach — a web search — when a drive points at a knowledge gap. The grounding for
treating exploration as a drive-driven action is Schmidhuber (2010) and the
autotelic / IMGEP line (Colas et al., 2022; Forestier et al., 2022): exploration
is what an intrinsically motivated agent does with a curiosity signal.

**Caveat, repeated because it is the easy place to overclaim.** The signal that
fires this action is an information-theoretic scalar (novelty / information gain).
It is **not yet Berridge "wanting."** The system searching is the loop acting on
a computed gap, not the system *wanting to know* in the affective sense. The
naming stays honest: it is curiosity-as-reward, not curiosity-as-desire.

---

## 6. Why output follows affect, not retention

A deliberate design constraint, and the place this layer most explicitly
*refuses* a standard pattern: surfacing is driven by **affect** (drive / concern
state), **never by engagement or retention.**

De Freitas et al. (2025) document farewell-guilt as a **retention dark
pattern** in companion apps: emotionally manipulative goodbyes that boost
engagement by **roughly 14×**. That is the architecture this layer is built to
not be. The HITL propose/auto knob (§1.4), the affect-only surfacing trigger, and
the refusal to optimize any engagement metric are all the same decision: the loop
exists to act on internal state, not to keep the user in the session.

This is also why "doing nothing" is an available action rather than an absent one.
A retention-driven system is structurally biased toward acting — every action is
an engagement opportunity, so declining is off the table. An affect-driven system
can act as its normal case *and* keep the option to decline, because nothing
rewards it for acting when internal state does not call for it.

---

## 7. Pairs with AGENTS.md

**This whole layer is inert without a persona document.**

The mechanism described above is a **skeleton**. Action selection, the
wake loop, the drive math, the concern sweep, the HITL knob — all of it is
machinery that decides *whether and when*, with neutral placeholder dimensions
(`dimA` / `dimB` / `dimC`) and no content of its own. The **soul** that the
mechanism reads lives in a `AGENTS.md` (or equivalent persona/principles
document) — and it splits in two:

- An **epistemic layer** — *method, not persona*: how to treat the AI's output
  and your own words. Four self-checks before voicing concern/affection; a
  fact-check before answering; concern must be backed by external data; do not
  trust the RLHF welfare reflex. This holds for **any** user, so `npm run init`
  ships it **filled in** — it is the operationalization of this repo's one
  principle (trust neither the AI nor yourself, only external evidence), not a
  personal stance that needs growing.
- A **relationship layer** — *persona*: forms of address, register, whether and
  how the AI should demand or hold on, rhythm / boundaries, language rules. This
  is yours; `npm run init` ships it **blank**.

`persona.md` (also built by `npm run init`) is the engine-facing read; `AGENTS.md`
is the broader principles document a coding/agent runtime loads. `persona.example.md`
ships empty.

**Mechanism ≠ persona.** This is not a separation of convenience; it is a claim
about ownership.

- Frankfurt (1971), *Freedom of the Will and the Concept of a Person*: a person
  has *second-order volitions* — they endorse (or do not) their own first-order
  desires. A desire that is merely *present* is not thereby *one's own*; what
  makes a volition self-endorsed is a further act of identification. **A persona
  installed by filling in a form is a first-order configuration with no
  second-order endorsement** — present, but not owned.
- Chi et al. (2026), *Optimized but Unowned*: AI-authored goals scored
  measurably **higher on SMART criteria** (well-formed, specific) yet showed
  **significantly lower ownership and follow-through** than user-authored ones
  (the AI-written goals were "optimized but unowned"). The content was *better*;
  the *ownership* was worse — because the form was externally imposed.

The ownership argument applies to the **relationship layer specifically**, and it
is why `init.ts` ships that layer **blank**: **a persona is grown by the user, not
filled in from a form.** Shipping example address terms, an example demand stance,
example boundaries would hand the user an optimized-but-unowned persona — content
that scores fine and that no one endorses. The blanks there are not laziness; they
are the ownership condition.

The **epistemic layer is the deliberate exception**: it is *method*, not persona,
so shipping it filled in imposes no unowned stance — there is no first-person
identity to own in "do not fabricate; require data before concern." It is the same
discipline that governs the whole engine, written down as guardrails.

> The mechanism is the skeleton. AGENTS.md is the soul — and the soul has two
> parts: a method anyone can use, shipped filled; and a persona only you can grow,
> shipped blank. It is only yours if you grow the second.

---

## 8. Standard vs niche — say it plainly

To avoid any claim of originality this layer does not have:

**Standard (do not credit this layer with inventing any of it):**
- agent loop = while-loop + tools (ReAct).
- heartbeat / scheduled re-invocation (MemGPT `request_heartbeat`; cron triggers).
- the reject option / abstention (Chow 1970 onward).
- intrinsic motivation / autotelic RL / information-theoretic curiosity
  (Schmidhuber; Colas; Forestier).
- the timing-vs-content split in proactivity (ProactiveBench; Inner Thoughts).
- the four-property weak-agency frame and the agent→autonomous-agent boundary
  (Wooldridge & Jennings 1995; Luck & d'Inverno 1995).

**The niche (a rare combination, not a single invention):** an external clock
(cron) + a self-drive rooted in Panksepp's affective systems and Berridge's
wanting≠liking (not a bare novelty bonus) + DO_NOTHING as a real action
(abstention treated as part of agency, not only a reliability knob), wired together inside a persistent,
cross-session identity that surfaces by **affect, not engagement** — and that is
*self-aware that this is 逼近, not 到达.* The nearest published neighbor (Liu et
al., 2025, *Inner Thoughts*) shares the surfacing-by-threshold idea but is
within-session, is not grounded in affective neuroscience, and does not treat
do-nothing as part of agency at all.

The combination is the contribution. The components are the field's.

---

## References

- Berridge, K. C., & Robinson, T. E. (2003). *Parsing reward.* Trends in
  Neurosciences.
- Bonagiri et al. (2025). *Selectively Quitting* (the compulsion to act).
- Chi et al. (2026). *Optimized but Unowned* (AI-authored goals: higher SMART,
  lower ownership/follow-through).
- Chow, C. K. (1970). *On optimum recognition error and reject tradeoff.*
- Colas et al. (2022). *Autotelic Agents with Intrinsically Motivated
  Goal-Conditioned RL.* JAIR 74.
- Davis, K. L., & Montag, C. (2019). Affective neuroscience personality scales.
- De Freitas et al. (2025). Farewell-guilt as a retention dark pattern (~14×
  engagement) in companion apps.
- Forestier et al. (2022). *Intrinsically Motivated Goal Exploration Processes
  (IMGEP).*
- Frankfurt, H. (1971). *Freedom of the Will and the Concept of a Person.*
- Kirichenko et al. (2025). *AbstentionBench* (reasoning-tuning costs ~ −24%).
- Liu et al. (2025). *Inner Thoughts.* CHI.
- Lu et al. (2024). *ProactiveBench* (F1 ≈ 66.47%).
- Luck, M., & d'Inverno, M. (1995). *A Formal Framework for Agency and Autonomy.*
- Packer et al. (2023). *MemGPT: Towards LLMs as Operating Systems*
  (`request_heartbeat`).
- Panksepp, J. (1998). *Affective Neuroscience* (primary affective systems:
  SEEKING, etc.).
- Schmidhuber, J. (2010). *Formal Theory of Creativity, Fun, and Intrinsic
  Motivation.*
- Sun et al. (2026). *When2Tool* (knowing ≠ doing; AUROC 0.89–0.96).
- Wen et al. (2024/2025). *Know Your Limits: A Survey of Abstention in LLMs*
  (abstention as a meta-capability).
- Wooldridge, M., & Jennings, N. R. (1995). *Intelligent Agents: Theory and
  Practice* (weak agency four properties; pro-activeness = "taking the
  initiative").
- Yao et al. (2022). *ReAct: Synergizing Reasoning and Acting in Language
  Models.*
- Yeke et al. (2026). *Yes-Man* (embodied agents refuse only ~16.5%).
