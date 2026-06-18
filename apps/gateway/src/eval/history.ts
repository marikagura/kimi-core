// Trend reader — `npm run eval:history`
//
// Prints the last N retrieval_eval Events (written by runEval) newest-first, so
// you can see hit@10 / MRR / nDCG@10 move over time and spot a regression.
import "dotenv/config";
import { numEnv } from "../lib/env.js";
import prisma from "../db.js";

const N = numEnv("EVAL_HISTORY_N", 14);

async function main(): Promise<void> {
  const evs = await prisma.event.findMany({
    where: { source: "retrieval_eval" },
    orderBy: { createdAt: "desc" },
    take: N,
    select: { createdAt: true, value: true },
  });
  if (evs.length === 0) {
    console.log("no retrieval_eval events yet — run `npm run eval` first.");
    return;
  }
  for (const e of evs) console.log(`${e.createdAt.toISOString().slice(0, 16)}  ${e.value}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
