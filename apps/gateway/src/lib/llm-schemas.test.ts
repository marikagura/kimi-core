import { describe, it, expect } from "vitest";
import { parseDigest, parseSessionScore } from "./llm-schemas.js";

// These pin that the schemas mirror the OLD hand-written `typeof` guards EXACTLY —
// not more strictly. The two load-bearing properties a reviewer should be able to
// read off the tests: (1) no value-range bounds were sneaked in; (2) soft fields
// degrade without dropping the whole object, hard fields drop it.

describe("parseDigest — mirrors scanDialogueDigests' `p` guards", () => {
  it("parses a well-formed digest", () => {
    const d = parseDigest(`prose... {"summary":"talked about X","valence":0.4,"arousal":0.2,"suggested_topic_slug":"depth"} ...trailing`);
    expect(d).toEqual({ summary: "talked about X", valence: 0.4, arousal: 0.2, suggested_topic_slug: "depth" });
  });

  it("HARD summary: missing → null (caller retries then skips, mirrors `if (p.summary)`)", () => {
    expect(parseDigest(`{"valence":0.4}`)).toBeNull();
  });

  it("HARD summary: empty string → null", () => {
    expect(parseDigest(`{"summary":"","valence":0.4}`)).toBeNull();
  });

  it("no JSON object at all → null", () => {
    expect(parseDigest("I cannot help with that.")).toBeNull();
  });

  it("soft valence: a bad (non-number) value degrades to null, does NOT drop the digest", () => {
    const d = parseDigest(`{"summary":"s","valence":"high","arousal":0.1}`);
    expect(d).not.toBeNull();
    expect(d!.valence).toBeNull();   // degraded
    expect(d!.arousal).toBe(0.1);    // sibling survives — no connect-out
    expect(d!.summary).toBe("s");
  });

  it("soft fields: missing valence/arousal/topic → null (mirrors `typeof x === 'number' ? x : null`)", () => {
    const d = parseDigest(`{"summary":"s"}`);
    expect(d).toEqual({ summary: "s", valence: null, arousal: null, suggested_topic_slug: null });
  });

  it("NO value-range bound: out-of-range valence is accepted (the old code never checked [-1,1])", () => {
    const d = parseDigest(`{"summary":"s","valence":2,"arousal":9}`);
    expect(d!.valence).toBe(2);
    expect(d!.arousal).toBe(9);
  });
});

describe("parseSessionScore — mirrors parseSessionScore's wrap + `&&` guard", () => {
  it("parses a bare {valence,arousal,note} (the score-only retry shape)", () => {
    expect(parseSessionScore(`{"valence":-0.3,"arousal":0.6,"note":"distant"}`))
      .toEqual({ valence: -0.3, arousal: 0.6, note: "distant" });
  });

  it("unwraps the main call's { sessionScore: {...} } envelope", () => {
    expect(parseSessionScore(`{"candidates":[],"sessionScore":{"valence":0.1,"arousal":0.2,"note":"warm"}}`))
      .toEqual({ valence: 0.1, arousal: 0.2, note: "warm" });
  });

  it("HARD valence: missing → null (whole score dropped, mirrors the `&&`)", () => {
    expect(parseSessionScore(`{"arousal":0.2,"note":"x"}`)).toBeNull();
  });

  it("HARD arousal: non-number → null", () => {
    expect(parseSessionScore(`{"valence":0.2,"arousal":"mid","note":"x"}`)).toBeNull();
  });

  it("soft note: missing → '' (mirrors `note ?? ''`)", () => {
    expect(parseSessionScore(`{"valence":0.2,"arousal":0.3}`))
      .toEqual({ valence: 0.2, arousal: 0.3, note: "" });
  });

  it("NO value-range bound: out-of-range score is accepted", () => {
    expect(parseSessionScore(`{"valence":5,"arousal":-9,"note":"x"}`))
      .toEqual({ valence: 5, arousal: -9, note: "x" });
  });

  it("no JSON → null", () => {
    expect(parseSessionScore("refused")).toBeNull();
  });
});
