import { describe, it, expect } from "vitest";
import { buildPersonaMd, buildAgentsMd, section, type Answers } from "./persona-build.js";

const full: Answers = {
  aiName: "Aria",
  addressing: "它叫我 你，我叫它 Aria",
  tone: "平实、温暖",
  demand: "要，抓着我别轻易放",
  boundaries: "夜里活动；有数据才准 concern",
  language: "默认中文，简短",
  drives: ["companionship", "desire", "deep_talk"],
};

describe("buildPersonaMd", () => {
  it("uses the name and lists the drives", () => {
    const md = buildPersonaMd(full);
    expect(md).toContain("你是 Aria。");
    expect(md).toContain("- companionship");
    expect(md).toContain("- deep_talk");
  });
  it("omits addressing/tone lines when those answers are blank", () => {
    const md = buildPersonaMd({ ...full, addressing: "", tone: "" });
    expect(md).not.toContain("称呼:");
    expect(md).not.toContain("语气 / register:");
  });
  it("falls back to a DRIVE_DIMS pointer when no drives are given", () => {
    expect(buildPersonaMd({ ...full, drives: [] })).toContain("DRIVE_DIMS");
  });
});

describe("section — verbatim answer or a blank TODO, never invented", () => {
  it("emits the user's answer when present", () => {
    expect(section("称呼", "叫我 你", "todo")).toBe("### 称呼\n叫我 你\n");
  });
  it("keeps a TODO comment (blank) when the answer is empty", () => {
    expect(section("称呼", "   ", "fill me")).toBe("### 称呼\n<!-- fill me -->\n");
  });
});

describe("buildAgentsMd", () => {
  it("ships the epistemic layer filled", () => {
    const md = buildAgentsMd(full);
    expect(md).toContain("只信外在证据");
    expect(md).toContain("表达 concern 或 affection 前");
  });
  it("grows the relationship layer from the user's own words", () => {
    const md = buildAgentsMd(full);
    expect(md).toContain("要，抓着我别轻易放"); // demand, verbatim
    expect(md).toContain("默认中文，简短"); // language, verbatim
  });
  it("leaves a skipped relationship section blank (a TODO), not invented", () => {
    const md = buildAgentsMd({ ...full, demand: "" });
    expect(md).not.toContain("要，抓着我别轻易放");
    expect(md).toMatch(/### demand \/ 立场\n<!--/);
  });
});
