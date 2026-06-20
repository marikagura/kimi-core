// Curation-health probe — surfaces signals that the append-only memory store needs
// human curation. The engine never auto-consolidates (by design: trust neither the
// AI nor yourself — see ARCHITECTURE / EPISTEMIC), so the store grows until curated
// by hand. This probe turns "you should review your memories" from dashboard-only
// tribal knowledge into a daemon signal: it rides the daily intel summary and can be
// surfaced through the notifier, so a deployment with no backstage UI still gets nudged.

import prisma from "../db.js";
import { numEnv } from "./env.js";

export type CurationHealth = {
  /** Active memories. Append-only — grows until you curate. */
  activeTotal: number;
  /** importance >= HIGH active memories — the manual-review pool (identity / commitments / boundaries). */
  highImportance: number;
  /** OPEN SELF memories still being tracked. */
  openConcerns: number;
  /** Fired nudges (e.g. the high-importance pool crossed the review threshold). */
  flags: string[];
};

const HIGH = 5;

export async function checkCurationHealth(): Promise<CurationHealth> {
  // Nudge once the high-importance pool crosses this. Tunable per deployment.
  const reviewThreshold = numEnv("CURATION_REVIEW_THRESHOLD", 30);
  const [activeTotal, highImportance, openConcerns] = await Promise.all([
    prisma.memory.count({ where: { isActive: true } }),
    prisma.memory.count({ where: { isActive: true, importance: { gte: HIGH } } }),
    prisma.memory.count({ where: { isActive: true, experiencer: "SELF", resolution: "OPEN" } }),
  ]);
  const flags: string[] = [];
  if (highImportance >= reviewThreshold) flags.push(`review-high-importance(${highImportance})`);
  return { activeTotal, highImportance, openConcerns, flags };
}
