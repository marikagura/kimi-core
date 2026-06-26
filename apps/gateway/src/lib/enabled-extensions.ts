// Opt-in extension wiring driven by env. KIMI_EXTENSIONS is a comma-separated
// list of extension names to mount (e.g. "store" or "store,paper"). Empty / unset
// → none, preserving the core memory engine exactly as shipped. To add a new
// extension, register it in REGISTRY below; deployments turn it on by name.

import type { KimiExtension } from "./extensions.js";
import { storeExtension } from "../extensions/store/index.js";
import { paperExtension } from "../extensions/paper/index.js";

const REGISTRY: Record<string, KimiExtension> = {
  store: storeExtension,
  paper: paperExtension,
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
