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

// In-process overlap lock, mirroring intel.ts digestTick. One run makes a distill()
// LLM call per hit (up to ~9 min for 30 hits with retries), which can outlast a
// tight PAPER_LOOP_CRON interval. node-cron does not skip a tick while the previous
// async callback is pending, so without this two runs overlap — doubled LLM spend,
// doubled NCBI request rate, and a racing dedup that can throw a unique-constraint
// violation on create.
let paperLoopRunning = false;
async function runPaperLoopGuarded(): Promise<void> {
  if (paperLoopRunning) {
    console.log("[paper] skip — previous loop still in flight");
    return;
  }
  paperLoopRunning = true;
  try {
    await runPaperLoop();
  } finally {
    paperLoopRunning = false;
  }
}

function registerPaperLoop(): void {
  const sched = process.env.PAPER_LOOP_CRON;
  if (!sched) {
    console.log("[paper] tools enabled; set PAPER_LOOP_CRON to schedule the digest loop");
    return;
  }
  // Validate before scheduling: node-cron throws synchronously on a malformed
  // pattern, which would otherwise propagate out of the daemon's extension loader.
  if (!cron.validate(sched)) {
    console.error(`[paper] invalid PAPER_LOOP_CRON "${sched}" — skipping schedule`);
    return;
  }
  const tz = process.env.KIMI_CRON_TZ || DEFAULT_TZ;
  cron.schedule(
    sched,
    () => {
      runPaperLoopGuarded().catch((e) => console.error("[paper] loop error:", e?.message || e));
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
