import { describe, it, expect, vi, afterEach } from "vitest";
import { loadExtensionActions, type KimiExtension } from "./extensions.js";

// Proves the unified opt-in: one KIMI_EXTENSIONS env enables BOTH tool-extensions
// (registerTools) and daemon-action/feed extensions (registerActions). No DB.
describe("unified opt-in", () => {
  const prev = process.env.KIMI_EXTENSIONS;
  afterEach(() => {
    if (prev === undefined) delete process.env.KIMI_EXTENSIONS;
    else process.env.KIMI_EXTENSIONS = prev;
  });

  it("loadExtensionActions runs registerActions only where present; empty is a no-op", () => {
    const withAction = { name: "a", registerActions: vi.fn() };
    const toolsOnly = { name: "b", registerTools: vi.fn() };
    loadExtensionActions([withAction, toolsOnly] as KimiExtension[]);
    expect(withAction.registerActions).toHaveBeenCalledOnce();
    expect(() => loadExtensionActions([])).not.toThrow();
  });

  it("enabledExtensions resolves travel + demo-feed by name; empty env → none", async () => {
    const { enabledExtensions } = await import("./enabled-extensions.js");
    process.env.KIMI_EXTENSIONS = "travel,demo-feed";
    const names = enabledExtensions().map((e) => e.name);
    expect(names).toContain("travel");
    expect(names).toContain("demo-feed");
    // every resolved extension exposes at least one seam
    for (const ext of enabledExtensions()) {
      expect(Boolean(ext.registerTools) || Boolean(ext.registerActions)).toBe(true);
    }
    process.env.KIMI_EXTENSIONS = "";
    expect(enabledExtensions()).toHaveLength(0);
  });
});
