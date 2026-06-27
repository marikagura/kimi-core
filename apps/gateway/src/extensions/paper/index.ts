// Paper extension — opt-in. Adds paper_search / paper_write tools over the
// paper_notes store (registerTools), and optionally schedules the digest loop in
// the daemon (registerActions, gated on PAPER_LOOP_CRON).
//
// Enable by name:  KIMI_EXTENSIONS=paper
//   - tools:  paper_search / paper_write are mounted on the MCP server.
//   - loop:   set PAPER_LOOP_CRON (e.g. "0 9 * * *") to run the fetch+distill loop
//             periodically in the daemon. Unset → no scheduled crawl (the manual
//             `npm run paper:loop` still works). Off by default — the loop makes
//             network + LLM calls.

import cron from "node-cron";
import type { KimiExtension } from "../../lib/extensions.js";
import { DEFAULT_TZ } from "../../time.js";
import { registerPaperTools } from "./tools.js";
import { runPaperLoop } from "./loop.js";

function registerPaperLoop(): void {
  const sched = process.env.PAPER_LOOP_CRON;
  if (!sched) {
    console.log("[paper] tools enabled; set PAPER_LOOP_CRON to schedule the digest loop");
    return;
  }
  const tz = process.env.KIMI_CRON_TZ || DEFAULT_TZ;
  cron.schedule(
    sched,
    () => {
      runPaperLoop().catch((e) => console.error("[paper] loop error:", e?.message || e));
    },
    { timezone: tz },
  );
  console.log(`[paper] digest loop scheduled — cron "${sched}" (${tz})`);
}

export const paperExtension: KimiExtension = {
  name: "paper",
  registerTools: registerPaperTools,
  registerActions: registerPaperLoop,
};
