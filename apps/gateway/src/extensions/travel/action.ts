// Travel — a sample OPT-IN daemon action, demonstrating the registerAction seam
// with an OUTWARD, GENERATIVE action (contrast DIARY's inward self-reflection).
//
// When the wake daemon chooses "TRAVEL", the agent has generated an imaginative
// outing this tick (parsed.action_content); this handler records it as an
// EPISODE memory under the same autonomy gate + decision marker the built-ins use.
// Delivery (a push) is the daemon's pluggable Notifier, wired separately — not here.
//
// OPT-IN: core does not register this by default. Turn it on by name —
//   KIMI_EXTENSIONS=travel  (it is in the enabled-extensions REGISTRY; the daemon
// calls its registerActions seam at startup). Equivalent manual wiring, if you are
// not using the env registry:  registerTravelAction();
//
// A sample action shape only: the daemon generates the content (from your
// persona.md), the Notifier handles delivery — this handler just records it.

import prisma from "../../db.js";
import { localDateTime } from "../../time.js";
import {
  registerAction,
  writeDecisionMarker,
  modeOf,
  type ActionHandler,
  type ActionContext,
  type ActionResult,
} from "../../lib/agency.js";
import type { KimiExtension } from "../../lib/extensions.js";

const TRAVEL = "TRAVEL";

export const travelAction: ActionHandler = {
  type: TRAVEL,
  describe: () =>
    "Record an imaginative outing the agent generated this tick as an EPISODE memory (opt-in sample generative action).",
  async run(ctx: ActionContext): Promise<ActionResult> {
    const { parsed, now } = ctx;
    const body = (parsed.action_content ?? "").trim();
    if (!body) {
      const markerId = await writeDecisionMarker(TRAVEL, "skipped", "empty content", ctx);
      return { type: TRAVEL, performed: false, outcome: "skipped", detail: "empty content", markerId };
    }
    const ts = localDateTime(now).slice(0, 16);

    // propose mode (HITL): park it, withhold the memory write.
    if (modeOf(ctx) === "propose") {
      const markerId = await writeDecisionMarker(TRAVEL, "staged", "outing pending confirmation", ctx, {
        preview: body.slice(0, 200),
        ts,
      });
      return { type: TRAVEL, performed: false, outcome: "staged", detail: ts, markerId };
    }

    // auto mode: record the outing as a SELF EPISODE. RESOLVED — an outing is not
    // an open question, so the concern deriver never picks it up.
    const mem = await prisma.memory.create({
      data: {
        title: `outing ${ts}`,
        content: body,
        memoryType: "EPISODE",
        importance: 2,
        sourceType: "EVENT",
        summary: body.slice(0, 120),
        experiencer: "SELF",
        resolution: "RESOLVED",
        valence: typeof parsed.valence === "number" ? parsed.valence : null,
        arousal: typeof parsed.arousal === "number" ? parsed.arousal : null,
      },
      select: { id: true },
    });
    const markerId = await writeDecisionMarker(TRAVEL, "committed", "outing recorded", ctx, { memoryId: mem.id, ts });
    return { type: TRAVEL, performed: true, outcome: "committed", detail: ts, markerId, artifactId: mem.id };
  },
};

/** Opt-in: register the TRAVEL action. Core does not call this. */
export function registerTravelAction(): void {
  registerAction(travelAction);
}

/**
 * Opt-in extension wrapper. Enable by name via KIMI_EXTENSIONS=travel (registered
 * in lib/enabled-extensions.ts). Travel is daemon-side only (no MCP tools), so it
 * implements the registerActions seam; the daemon wires it at startup.
 */
export const travelExtension: KimiExtension = {
  name: "travel",
  registerActions: registerTravelAction,
};
