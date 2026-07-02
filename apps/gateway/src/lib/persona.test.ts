import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPersonaDoc, personaPath } from "./persona.js";

// The wire from `npm run init`'s persona.md to the daemon's system prompt: the
// loader must find the repo-root file both from the root itself and from a
// nested process cwd (apps/gateway), and must degrade to "" — never throw —
// when the file is absent.

const cwd0 = process.cwd();
let tmp: string | null = null;

afterEach(() => {
  process.chdir(cwd0);
  delete process.env.PERSONA_PATH;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function makeRepo(): { root: string; nested: string } {
  tmp = mkdtempSync(join(tmpdir(), "persona-"));
  const nested = join(tmp, "apps", "gateway");
  mkdirSync(nested, { recursive: true });
  return { root: tmp, nested };
}

describe("loadPersonaDoc", () => {
  it("reads persona.md from the cwd", () => {
    const { root } = makeRepo();
    writeFileSync(join(root, "persona.md"), "# me\n");
    process.chdir(root);
    expect(loadPersonaDoc()).toBe("# me");
  });

  it("walks up to the repo root from a nested cwd (apps/gateway)", () => {
    const { root, nested } = makeRepo();
    writeFileSync(join(root, "persona.md"), "root persona");
    process.chdir(nested);
    expect(loadPersonaDoc()).toBe("root persona");
  });

  it("PERSONA_PATH overrides the walk", () => {
    const { root, nested } = makeRepo();
    writeFileSync(join(root, "persona.md"), "root persona");
    const other = join(root, "other.md");
    writeFileSync(other, "explicit persona");
    process.env.PERSONA_PATH = other;
    process.chdir(nested);
    expect(loadPersonaDoc()).toBe("explicit persona");
  });

  it("returns \"\" (never throws) when nothing resolves", () => {
    const { nested } = makeRepo();
    process.chdir(nested);
    // depth cap: cwd + 2 parents — the tmp root has no persona.md
    expect(personaPath()).toBeNull();
    expect(loadPersonaDoc()).toBe("");
  });
});
