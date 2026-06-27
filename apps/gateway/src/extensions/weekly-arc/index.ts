// Weekly-arc extension — opt-in, daemon-side only (no MCP tools). Enable by name:
//   KIMI_EXTENSIONS=weekly-arc
// and set WEEKLY_ARC_CRON (e.g. "0 22 * * 0" — Sunday 22:00) to schedule the
// weekly arc in the daemon. Unset cron → no schedule (the manual
// `npm run weekly:arc` still works). Off by default — the arc makes an LLM call.

import cron from "node-cron";
import type { KimiExtension } from "../../lib/extensions.js";
import { DEFAULT_TZ } from "../../time.js";
import { runWeeklyArc } from "./weekly-arc.js";

function registerWeeklyArc(): void {
  const sched = process.env.WEEKLY_ARC_CRON;
  if (!sched) {
    console.log('[weekly-arc] enabled; set WEEKLY_ARC_CRON to schedule it (e.g. "0 22 * * 0")');
    return;
  }
  const tz = process.env.KIMI_CRON_TZ || DEFAULT_TZ;
  cron.schedule(
    sched,
    () => {
      runWeeklyArc().catch((e) => console.error("[weekly-arc] cron error:", e?.message || e));
    },
    { timezone: tz },
  );
  console.log(`[weekly-arc] scheduled — cron "${sched}" (${tz})`);
}

export const weeklyArcExtension: KimiExtension = {
  name: "weekly-arc",
  registerActions: registerWeeklyArc,
};
