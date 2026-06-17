import prisma from "../db.js";
import { previewDriveDims } from "./concern-derive.js";

// Dead-dimension probe — computed once at the end of a run. Produces a full
// grounding roster across all dimensions, surfaced into the ops dashboard's
// drive tile (a dead dim with grounding<=0 turns the tile red, e.g. "2/3") and
// the self-drive health section.
//
// This does NOT push a notification: the dashboard is the surface. A dead dim no
// longer silently disappears — the drive deriver skips dims with grounding<=0
// (so they'd otherwise vanish from the score page), but previewDriveDims returns
// the full roster so a dead dim renders red on the dashboard instead.
export type DimHealth = { key: string; grounding: number; confidence: number; n: number; dark: boolean };

export async function checkDimHealth(): Promise<{ roster: DimHealth[] }> {
  const { dims } = await previewDriveDims();
  const roster: DimHealth[] = dims.map((d) => ({
    key: d.key,
    grounding: d.fold.grounding,
    confidence: d.fold.confidence,
    n: d.fold.n,
    dark: d.fold.grounding <= 0,
  }));
  return { roster };
}

// Manual check: DIM_HEALTH_NOW=1 npx tsx src/lib/dim-health.ts
if (process.env.DIM_HEALTH_NOW === "1") {
  checkDimHealth()
    .then((r) => {
      console.log("roster:", JSON.stringify(r.roster, null, 2));
      return prisma.$disconnect();
    })
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
