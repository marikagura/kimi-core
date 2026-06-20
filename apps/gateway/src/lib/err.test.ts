import { describe, it, expect } from "vitest";
import { errMessage } from "./err.js";

describe("errMessage", () => {
  it("returns an Error's message", () => {
    expect(errMessage(new Error("boom"))).toBe("boom");
  });
  it("stringifies a non-Error value (what the old `?? e` would log)", () => {
    expect(errMessage("plain")).toBe("plain");
    expect(errMessage(42)).toBe("42");
    expect(errMessage({ code: "X" })).toBe("[object Object]");
  });
  it("handles null / undefined", () => {
    expect(errMessage(null)).toBe("null");
    expect(errMessage(undefined)).toBe("undefined");
  });
});

// Differential vs the three idioms errMessage replaced at the catch sites
// (`e.message`, `e?.message || e`, `e?.message ?? e`). For a real Error — the
// realistic throw — all three equal errMessage. For non-Error throws errMessage is
// equal-or-safer (a clean string, never the undefined/object/throw the old idioms
// could yield); that is the only divergence and it is a strict improvement.
describe("errMessage — differential vs the replaced catch idioms", () => {
  const idiomOr = (e: any) => e?.message || e; // embed / reranker / cost-log / daemon / http-server
  const idiomNul = (e: any) => e?.message ?? e; // depth-judge / intel digest

  it("Error (the realistic throw): byte-identical to every old idiom", () => {
    const e = new Error("boom");
    expect(errMessage(e)).toBe("boom");
    expect(errMessage(e)).toBe(idiomOr(e));
    expect(errMessage(e)).toBe(idiomNul(e));
    expect(errMessage(e)).toBe(e.message); // the bare `e.message` idiom
  });

  it("non-Error: a clean string where the old idioms degraded", () => {
    expect(errMessage("oops")).toBe("oops"); // ||/?? also "oops"; bare e.message → undefined
    expect(errMessage({ code: "X" })).toBe("[object Object]"); // template form of the object idioms
    expect(errMessage(null)).toBe("null"); // bare `null.message` would THROW; errMessage is safe
  });
});
