// Per-session self-score write — extracted from the intel digest loop so it is a
// side-effect-free, testable module (intel.ts is the daemon entry and self-runs
// at import). scanDialogueDigests calls writeSessionScore once per scored session.

import prisma from "../db.js";
import { roleModel } from "./models.js";
import { errMessage } from "./err.js";

// Write the per-session self-score memory (SELF_SCORE) from the digest's v/a.
// Dedup by the date+time title so a re-run doesn't double-write. RESOLVED — a
// session score is a snapshot, not an open concern. Tolerates its own write
// failure (logs, returns written:false) so a score error never fails the digest.
export async function writeSessionScore(args: {
  dateStr: string;
  startHHMM: string;
  valence: number;
  arousal: number | null;
  note: string;
  firstAt: Date;
  lastAt: Date;
}): Promise<{ written: boolean }> {
  const scoreTitle = `chat-score ${args.dateStr} ${args.startHHMM}`;
  const exists = await prisma.memory.findFirst({
    where: { memoryType: "SELF_SCORE", title: scoreTitle },
    select: { id: true },
  });
  if (exists) return { written: false };
  const body = args.note || `${args.dateStr} session`;
  try {
    await prisma.memory.create({
      data: {
        memoryType: "SELF_SCORE",
        title: scoreTitle,
        summary: body,
        content: body,
        importance: 3,
        experiencer: "SELF",
        resolution: "RESOLVED",
        valence: args.valence,
        arousal: args.arousal,
        sourceType: "CHAT",
        authorModel: roleModel("INTEL_SCORE_AUTHOR_MODEL"),
        digestTimeStart: args.firstAt,
        digestTimeEnd: args.lastAt,
        validFrom: args.lastAt,
      },
    });
    return { written: true };
  } catch (err: unknown) {
    console.error(`[dialogue_digest] ${args.dateStr} self-score write failed:`, errMessage(err));
    return { written: false };
  }
}
