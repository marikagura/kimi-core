// Travel — a sample OPT-IN daemon action, demonstrating the registerAction seam
// with an OUTWARD, GENERATIVE action (contrast DIARY's inward self-reflection).
//
// When the wake daemon chooses "TRAVEL", the agent has generated an imaginative
// outing / scene this tick (parsed.action_content); this handler records it as an
// EPISODE memory under the same autonomy gate + decision marker the built-ins use.
// Delivery (a push) is the daemon's pluggable Notifier, wired separately — not here.
//
// OPT-IN: core does not register this. A deployment enables it before the daemon
// starts:  import { registerTravelAction } from "./extensions/travel/action.js";
//          registerTravelAction();
//
// (Generalized from a live build's "travel" daemon — persona prompt, push timing,
// and field-specific content were stripped; what remains is the action shape.)

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

const TRAVEL = "TRAVEL";

export const travelAction: ActionHandler = {
  type: TRAVEL,
  describe: () =>
    "Record an imaginative outing/scene the agent generated this tick as an EPISODE memory (opt-in sample generative action).",
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
