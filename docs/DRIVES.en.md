> 中文：./DRIVES.md

# Define your own drive dimensions

The self-drive engine ships **no built-in dimension**. There is no factory
"intimacy" or "companionship" persona — **the dimensions are yours to define**:
what each is called, which memories ground it, and which of the four SEEKING
shapes governs how its *wanting* moves over time. The roster in the repo is only
an **example**.

This is the same stance as shipping the persona empty (see
[AUTONOMY.md §7](./AUTONOMY.en.md)): a desire filled in from a form isn't yours.
**A drive is grown and chosen, not configured.** So we give you a menu and an
example, and you grow the rest.

---

## Step 1: ask what this companion *wants*

Don't start from code. List the cravings in this relationship that **rise and
fall over time**. For each, ask the key question: **how does it move?**

- Right after it's satisfied — do you want it *more*, or not for a while?
- After a long gap — does it build, or fade?
- After once being "caught" — does it settle for a few days?

Your answers decide which of the four shapes it is. How many dimensions, and what
they're called, is entirely yours — three, five, whatever; name them in your own
words.

---

## Step 2: the four shapes (the menu)

The engine implements exactly these four wanting curves (all in `foldDim`,
`concern-derive.ts`). `recency = exp(−Δd/τ)` (high right after); `want = min(1,
Δd/scale)` (high after a drought).

| shape | formula | the wanting it models | fits | root |
|---|---|---|---|---|
| `symmetric` | `max(recency, want)` | U-shape: high right after AND after a long gap, low in the middle | presence / companionship | Panksepp SEEKING |
| `refractory` | `max(want·(1−recency), floor)` | refractory: suppressed right after satisfaction, with a tonic floor that never hits zero | appetite / desire | Panksepp consummatory refractory |
| `bonding` | `max(recency·(1−sat), want)` | bonding satiety: a **closed positive** bond presses the recency leg for a while; the want leg returns after a few days | deep talk / connection | Berridge / bonding satiety |
| `owed` | `want` (want-only) | sensitized wanting: the longer unfulfilled, the more wanted; no "just-satisfied" high end | debt / what's owed | Berridge incentive sensitization |

**Choosing**: map each craving's "how it moves" onto the table. "Don't want it
right after" → `refractory`; "settles once caught" → `bonding`; "the longer owed
the more wanted" → `owed`; "high at both ends" → `symmetric`.

---

## Step 3: write it into config

List your dimensions under `selfDrive.drives` in `config.yaml` (or override the
whole roster with the `DRIVE_DIMS` env — a JSON array of the same shape). Each
dimension:

```yaml
selfDrive:
  drives:
    - key: longing            # machine id (slug)
      label: "Longing"        # display name — yours to pick
      shape: symmetric        # symmetric | refractory | bonding | owed
      backing:                # which memories ground it (all optional, combine as needed)
        memoryTypes: [EPISODE]       # only these types; omit = any
        experiencers: [SELF, SHARED] # omit = don't filter by experiencer
        valenceFloor: 0.3            # only backing with valence >= this
        titlePrefix: "[A "           # only titles starting with this marker
        excludeWords: ["x"]          # drop backing whose content contains any of these
        topicSlug: "depth-topic"     # back the dim on memories tagged to a topic
        presence: lastChat           # add a presence anchor (last chat timestamp) to the recency leg
      wantScale: 14           # days for the want leg to fill (omit → global default)
```

Each dimension yields `confidence = grounding × drive`:
- `grounding` = mean valence of the dim's backing within the 90-day window (no
  history → 0 → the dim **doesn't stand up**, which guards against neediness).
- `drive` = the curve its shape selects.

A dim with `grounding ≤ 0` is not projected as a `SELF_DRIVE`, but it shows up red
in dim-health (a dead dim is visible, not silently gone).

---

## The example roster (what ships)

Four, one per shape. **This is a demonstration, not for you — replace it.**

| example key | example name | shape | backing |
|---|---|---|---|
| `companionship` | companionship | `symmetric` | positive EPISODEs + a last-chat presence anchor |
| `desire` | desire | `refractory` | RESTRICTED memories |
| `deep_talk` | deep talk | `bonding` | memories under the `depth-topic` topic |
| `owed` | owed | `owed` | memories under the `owed` topic |

Deleting these and writing your own is the correct use of this layer.

---

## One boundary

Don't adopt someone else's dimension semantics as yours. This example set
(companionship / desire / deep talk / owed) is a set of **generic relationship-
craving archetypes**, one per shape — not a specific person. What your companion
wants, and how those wants move, only you know. The engine gives the curves; the
names and the backing are yours to fill.
