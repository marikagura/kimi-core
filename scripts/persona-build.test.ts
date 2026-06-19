import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    expect(md).not.toContain("称呼：");
    expect(md).not.toContain("语气 / register：");
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

describe("epistemic layer stays in sync with EPISTEMIC.md", () => {
  // The epistemic layer exists in two copies: this generated AGENTS.md template
  // and the human-facing docs/EPISTEMIC.md. They drift silently (PATTERNS §8).
  // These assertions force the canonical markers to stay in both — edit one
  // copy without the other and a test here fails.
  // Repo-root-relative (tests run from the package root); avoids import.meta
  // (CommonJS build target) and __dirname (ESM test runtime).
  const doc = readFileSync(join(process.cwd(), "docs", "EPISTEMIC.md"), "utf8");
  const agents = buildAgentsMd(full);

  for (const marker of ["这一层不是默认配置", "没有数据就不表达 concern", "什么时候不查"]) {
    it(`both the doc and the AGENTS.md template carry: ${marker}`, () => {
      expect(doc).toContain(marker);
      expect(agents).toContain(marker);
    });
  }

  it("both ship exactly two concern self-checks, not four", () => {
    expect(agents).not.toContain("四条");
    expect(doc).not.toContain("四条");
    expect(agents).toContain("先过两条");
  });

  it("dropped phrasing stays dropped in the template", () => {
    expect(agents).not.toContain("不反射性道歉");
    expect(agents).not.toContain("是有争议的取舍");
  });
});
