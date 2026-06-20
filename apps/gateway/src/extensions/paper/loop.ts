// Paper loop — an on-demand CLI batch (NOT a cron / daemon): fetch recent papers
// from a source, distill each into a knowledge point with the LLM, and write to
// paper_notes (skipping any already stored). Run it yourself:  npm run paper:loop
// Wire it into your own scheduler later if you want it periodic.
//
// Configure the source for YOUR field below — the PubMed query here is a generic
// example. Swap pubMedAdapter(...) for any SourceAdapter (arXiv / Crossref / etc).

import "dotenv/config";
import prisma from "../../db.js";
import { callLLMShort } from "../../lib/llm.js";
import { errMessage } from "../../lib/err.js";
import { pubMedAdapter, type SourceAdapter, type PaperHit } from "./source.js";

// ── configure your field here ───────────────────────────────────────────────
const source: SourceAdapter = pubMedAdapter({
  // EXAMPLE query — replace with your field's E-utilities term.
  query: "(machine learning[tiab] OR deep learning[tiab]) AND review[pt]",
  // journalWhitelist: ["Nature", "Science"],  // optional, your field's venues
  days: 7,
});

async function distill(hit: PaperHit): Promise<string> {
  const system =
    "You are an academic note-taker. Given a paper's title and metadata, write one concise knowledge point — key finding / method / why it could be useful. Professional register, 1-3 sentences, no preamble.";
  const user = `Title: ${hit.title}\nJournal: ${hit.journal ?? "-"}\nAuthors: ${hit.authors ?? "-"}`;
  return (await callLLMShort(system, user, { maxTokens: 200 })).trim();
}

async function run(): Promise<void> {
  const hits = await source.fetchRecent();
  console.log(`[paper:loop] ${source.name}: ${hits.length} hits`);
  let written = 0, skipped = 0;
  for (const hit of hits) {
    if (hit.externalId) {
      const existing = await prisma.paperNote.findUnique({ where: { externalId: hit.externalId }, select: { id: true } });
      if (existing) { skipped++; continue; }
    }
    const knowledge = await distill(hit);
    await prisma.paperNote.create({
      data: {
        externalId: hit.externalId,
        title: hit.title,
        journal: hit.journal,
        authors: hit.authors,
        url: hit.url,
        publishedAt: hit.publishedAt ? new Date(hit.publishedAt) : undefined,
        knowledge,
      },
    });
    written++;
    console.log(`[paper:loop] wrote: ${hit.title.slice(0, 60)}`);
  }
  console.log(`[paper:loop] done — ${written} written, ${skipped} already stored`);
}

run()
  .then(() => process.exit(0))
  .catch((e: unknown) => { console.error("[paper:loop] error:", errMessage(e)); process.exit(1); });
