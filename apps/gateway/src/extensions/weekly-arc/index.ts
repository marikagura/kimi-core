// Weekly-arc extension — opt-in, daemon-side only (no MCP tools). Enable by name:
//   KIMI_EXTENSIONS=weekly-arc
// and set WEEKLY_ARC_CRON (e.g. "0 22 * * 0" — Sunday 22:00) to schedule the
// weekly arc in the daemon. Unset cron → no schedule (the manual
// `npm run weekly:arc` still works). Off by default — the arc makes an LLM call.

import cron from "node-cron";
import type { KimiExtension } from "../../lib/extensions.js";
import { DEFAULT_TZ } from "../../time.js";
import { runWeeklyArc } from "./weekly-arc.js";

// In-process overlap lock, mirroring intel.ts digestTick. A tight cron or a manual
// run overlapping the scheduled window could otherwise start a second runWeeklyArc
// while the first (a 180s-timeout LLM call) is still in flight — that doubles the
// LLM spend and is the mechanism that makes the dedup TOCTOU actually fire.
let arcRunning = false;
async function runWeeklyArcGuarded(): Promise<void> {
  if (arcRunning) {
    console.log("[weekly-arc] skip — previous run still in flight");
    return;
  }
  arcRunning = true;
  try {
    await runWeeklyArc();
  } finally {
    arcRunning = false;
  }
}

function registerWeeklyArc(): void {
  const sched = process.env.WEEKLY_ARC_CRON;
  if (!sched) {
    console.log('[weekly-arc] enabled; set WEEKLY_ARC_CRON to schedule it (e.g. "0 22 * * 0")');
    return;
  }
  // Validate before scheduling: node-cron throws synchronously on a malformed
  // pattern, which would otherwise propagate out of the daemon's extension loader.
  if (!cron.validate(sched)) {
    console.error(`[weekly-arc] invalid WEEKLY_ARC_CRON "${sched}" — skipping schedule`);
    return;
  }
  const tz = process.env.KIMI_CRON_TZ || DEFAULT_TZ;
  cron.schedule(
    sched,
    () => {
      runWeeklyArcGuarded().catch((e) => console.error("[weekly-arc] cron error:", e?.message || e));
    },
    { timezone: tz },
  );
  console.log(`[weekly-arc] scheduled — cron "${sched}" (${tz})`);
}

export const weeklyArcExtension: KimiExtension = {
  name: "weekly-arc",
  registerActions: registerWeeklyArc,
};
