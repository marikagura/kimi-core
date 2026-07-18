// Consolidate extension — opt-in, daemon-side only (no MCP tools). Enable by name:
//   KIMI_EXTENSIONS=consolidate
// and set CONSOLIDATE_CRON (e.g. "0 23 * * 0" — Sunday 23:00, after the weekly arc)
// to schedule the weekly consolidate pass. Unset cron → no schedule (the manual
// `npm run consolidate` still works). Off by default. Unlike the weekly arc it
// makes NO LLM call — it only computes candidates and writes one SYSTEM event.

import cron from "node-cron";
import type { KimiExtension } from "../../lib/extensions.js";
import { DEFAULT_TZ } from "../../time.js";
import { runConsolidate } from "./consolidate.js";

// In-process overlap lock, mirroring weekly-arc / intel digestTick. A tight cron or
// a manual run overlapping the scheduled window could otherwise start a second
// runConsolidate while the first is still reading the pool — harmless to the deduped
// event, but wasted work; the lock skips it.
let running = false;
async function runConsolidateGuarded(): Promise<void> {
  if (running) {
    console.log("[consolidate] skip — previous run still in flight");
    return;
  }
  running = true;
  try {
    await runConsolidate();
  } finally {
    running = false;
  }
}

function registerConsolidate(): void {
  const sched = process.env.CONSOLIDATE_CRON;
  if (!sched) {
    console.log('[consolidate] enabled; set CONSOLIDATE_CRON to schedule it (e.g. "0 23 * * 0")');
    return;
  }
  // Validate before scheduling: node-cron throws synchronously on a malformed
  // pattern, which would otherwise propagate out of the daemon's extension loader.
  if (!cron.validate(sched)) {
    console.error(`[consolidate] invalid CONSOLIDATE_CRON "${sched}" — skipping schedule`);
    return;
  }
  const tz = process.env.KIMI_CRON_TZ || DEFAULT_TZ;
  cron.schedule(
    sched,
    () => {
      runConsolidateGuarded().catch((e) => console.error("[consolidate] cron error:", e?.message || e));
    },
    { timezone: tz },
  );
  console.log(`[consolidate] scheduled — cron "${sched}" (${tz})`);
}

export const consolidateExtension: KimiExtension = {
  name: "consolidate",
  registerActions: registerConsolidate,
};
