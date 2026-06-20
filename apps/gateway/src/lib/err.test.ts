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
