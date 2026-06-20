import { describe, it, expect } from "vitest";
import { firstJsonObject } from "./json-extract.js";
import { parseDigest, parseSessionScore } from "./llm-schemas.js";

// Differential equivalence proof for the intel.ts wire (8ba55f4). The OLD inline
// parsers were deleted; they are rebuilt here verbatim as references, and run
// against the NEW schema-based path over the same inputs. For every REALISTIC LLM
// output shape the observable results must be byte-identical — that is the proof
// the refactor preserved behavior, not the claim "the change is mechanical".
//
// The only divergences are on MALFORMED inputs (a non-string summary / note), where
// the old weakly-typed code did String(123) / `note ?? ""` left 123, and the schema
// instead rejects or defaults. Those are listed explicitly at the end as the
// intentional, safer differences — not silent ones.

// ── old reference (verbatim pre-wire intel.ts) ──────────────────────────────────
function digestOld(raw: string) {
  const p: any = firstJsonObject(raw) ?? {};
  if (!p.summary) return { accepted: false as const };
  let scoreV: number | null = null, scoreA: number | null = null, scoreNote = "";
  if (typeof p.valence === "number") {
    scoreV = p.valence;
    scoreA = typeof p.arousal === "number" ? p.arousal : null;
    scoreNote = String(p.summary).split("\n")[0].slice(0, 120);
  }
  const topicSlug = (p.suggested_topic_slug && typeof p.suggested_topic_slug === "string") ? p.suggested_topic_slug : null;
  return {
    accepted: true as const,
    content: String(p.summary).slice(0, 2000),
    valence: typeof p.valence === "number" ? p.valence : null,
    arousal: typeof p.arousal === "number" ? p.arousal : null,
    topicSlug, scoreV, scoreA, scoreNote,
  };
}
function scoreOld(raw: string) {
  const obj: any = firstJsonObject(raw);
  if (!obj) return null;
  const score = obj.sessionScore ?? obj;
  if (score && typeof score.valence === "number" && typeof score.arousal === "number") {
    return { valence: score.valence, arousal: score.arousal, note: score.note ?? "" };
  }
  return null;
}

// ── new (post-wire intel.ts, via the schemas) ───────────────────────────────────
function digestNew(raw: string) {
  const p = parseDigest(raw);
  if (!p) return { accepted: false as const };
  let scoreV: number | null = null, scoreA: number | null = null, scoreNote = "";
  if (p.valence !== null) {
    scoreV = p.valence;
    scoreA = p.arousal;
    scoreNote = p.summary.split("\n")[0].slice(0, 120);
  }
  const topicSlug = p.suggested_topic_slug ? p.suggested_topic_slug : null;
  return {
    accepted: true as const,
    content: p.summary.slice(0, 2000),
    valence: p.valence, arousal: p.arousal,
    topicSlug, scoreV, scoreA, scoreNote,
  };
}
const scoreNew = (raw: string) => parseSessionScore(raw);

// ── realistic LLM outputs: old and new MUST agree ───────────────────────────────
const REALISTIC_DIGESTS = [
  `prose {"summary":"talked about X","valence":0.4,"arousal":0.2,"suggested_topic_slug":"depth"} tail`,
  `{"summary":"only summary"}`,                                  // no v/a/topic
  `{"summary":"s","valence":0.5}`,                               // valence, no arousal
  `{"summary":"s","valence":2,"arousal":9}`,                     // out of range — both kept
  `{"summary":"s","valence":-1,"arousal":0}`,                    // boundary values
  `{"valence":0.4,"arousal":0.1}`,                               // no summary -> skip
  `{"summary":""}`,                                              // empty summary -> skip
  `I cannot help with that.`,                                    // no JSON -> skip
  `{"summary":"s","valence":"high","arousal":0.1}`,             // bad valence -> degrades
  `{"summary":"first line\\nsecond line","valence":0.3}`,        // scoreNote = first line
  `{"summary":"s","suggested_topic_slug":123}`,                  // bad topic type -> null
  `{"summary":"s","suggested_topic_slug":null}`,                 // explicit null topic
];

const REALISTIC_SCORES = [
  `{"valence":-0.3,"arousal":0.6,"note":"distant"}`,            // bare
  `{"candidates":[],"sessionScore":{"valence":0.1,"arousal":0.2,"note":"warm"}}`, // wrapped
  `{"arousal":0.2,"note":"x"}`,                                  // missing valence -> null
  `{"valence":0.2,"arousal":"mid","note":"x"}`,                 // bad arousal -> null
  `{"valence":0.2,"arousal":0.3}`,                               // missing note -> ""
  `{"valence":5,"arousal":-9,"note":"x"}`,                       // out of range -> kept
  `refused, no json`,                                            // -> null
];

describe("intel wire — realistic LLM outputs: new path is byte-identical to old", () => {
  REALISTIC_DIGESTS.forEach((raw, i) => {
    it(`digest[${i}] old === new`, () => {
      expect(digestNew(raw)).toEqual(digestOld(raw));
    });
  });
  REALISTIC_SCORES.forEach((raw, i) => {
    it(`score[${i}] old === new`, () => {
      expect(scoreNew(raw)).toEqual(scoreOld(raw));
    });
  });
});

// The intentional, documented divergences — malformed (non-string) text fields. The
// old code coerced/passed them through; the schema rejects (digest) or defaults
// (note). Asserted so they can never become silent.
describe("intel wire — intentional safer divergences on malformed input", () => {
  it("non-string summary: old accepts String(123); new rejects (skip)", () => {
    expect(digestOld(`{"summary":123}`).accepted).toBe(true);
    expect(digestNew(`{"summary":123}`).accepted).toBe(false);
  });
  it("non-string note: old keeps 123; new defaults to ''", () => {
    expect(scoreOld(`{"valence":0.1,"arousal":0.2,"note":123}`)).toEqual({ valence: 0.1, arousal: 0.2, note: 123 });
    expect(scoreNew(`{"valence":0.1,"arousal":0.2,"note":123}`)).toEqual({ valence: 0.1, arousal: 0.2, note: "" });
  });
});
