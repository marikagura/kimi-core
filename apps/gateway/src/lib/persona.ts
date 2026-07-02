// Loads the external persona document (persona.md, built by `npm run init` —
// see persona.example.md) for buildPersona's `loadPersonaDoc` seam.
//
// Resolution order:
//   1. PERSONA_PATH env (absolute or cwd-relative), when set;
//   2. walk up from cwd looking for persona.md (max 3 levels) — the file lives
//      at the repo root, but the daemon/intel run with cwd=apps/gateway.
// Missing or unreadable file → "" (the engine runs persona-free), matching
// buildPersona's empty default; preflight requires the file for `npm run dev`,
// so a normal install always resolves it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function personaPath(): string | null {
  const explicit = process.env.PERSONA_PATH;
  if (explicit) return resolve(explicit);
  let dir = process.cwd();
  for (let i = 0; i < 3; i++) {
    const p = resolve(dir, "persona.md");
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadPersonaDoc(): string {
  const p = personaPath();
  if (!p) return "";
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}
