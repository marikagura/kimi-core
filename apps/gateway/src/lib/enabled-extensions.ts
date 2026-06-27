// Opt-in extension wiring driven by env. KIMI_EXTENSIONS is a comma-separated
// list of extension names to mount (e.g. "store" or "store,travel"). Empty / unset
// → none, preserving the core memory engine exactly as shipped. To add a new
// extension, register it in REGISTRY below; deployments turn it on by name.
//
// One registry, two seams (see lib/extensions.ts): an extension's registerTools is
// applied on the MCP-server side (index.ts / http-server.ts) and its registerActions
// on the daemon side (daemon.ts). `store` / `paper` are tools; `travel` is a daemon
// action — all enabled the same way, by name.

import type { KimiExtension } from "./extensions.js";
import { storeExtension } from "../extensions/store/index.js";
import { paperExtension } from "../extensions/paper/index.js";
import { travelExtension } from "../extensions/travel/action.js";
import { demoFeedExtension } from "../extensions/demo-feed/feed.js";
import { weeklyArcExtension } from "../extensions/weekly-arc/index.js";

const REGISTRY: Record<string, KimiExtension> = {
  store: storeExtension,
  paper: paperExtension,
  travel: travelExtension,
  "demo-feed": demoFeedExtension,
  "weekly-arc": weeklyArcExtension,
};

export function enabledExtensions(): KimiExtension[] {
  const names = (process.env.KIMI_EXTENSIONS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: KimiExtension[] = [];
  for (const n of names) {
    const ext = REGISTRY[n];
    if (ext) out.push(ext);
    else console.warn(`[ext] unknown extension in KIMI_EXTENSIONS: ${n}`);
  }
  return out;
}
