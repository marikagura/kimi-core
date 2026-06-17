/**
 * Reproducible retrieval eval —  npm run eval [path/to/dataset.jsonl]
 *
 * Reads a labeled set (one JSON object per line: { query, relevantIds }), runs
 * scoreMemories against your DB, and reports MRR / precision@k / recall@k.
 * Numbers you can re-run on your own data — not a claim in a README.
 *
 * Bring your own labeled set (see dataset.example.jsonl). With RERANK_PROVIDER
 * set you can A/B the rerank arm by flipping EVAL_RERANK=1.
 */
import { readFile } from "node:fs/promises";
import { scoreMemories } from "../lib/retrieval.js";

type EvalCase = { query: string; relevantIds: string[] };

const K = Number(process.env.EVAL_K ?? 10);
const useRerank = process.env.EVAL_RERANK === "1";

async function main(): Promise<void> {
  const path = process.argv[2] ?? "apps/gateway/src/eval/dataset.jsonl";
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    console.error(`No dataset at ${path}. Copy dataset.example.jsonl and label your own.`);
    process.exit(1);
  }

  const cases: EvalCase[] = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as EvalCase);
  if (!cases.length) {
    console.error("Empty dataset.");
    process.exit(1);
  }

  let mrr = 0;
  let precision = 0;
  let recall = 0;

  for (const c of cases) {
    const ranked = await scoreMemories(c.query, {
      limit: K,
      components: useRerank ? { rerank: true } : undefined,
    });
    const ids = ranked.map((m) => m.id);
    const rel = new Set(c.relevantIds);
    const firstHitRank = ids.findIndex((id) => rel.has(id)) + 1; // 0 = no hit
    const hits = ids.filter((id) => rel.has(id)).length;
    mrr += firstHitRank ? 1 / firstHitRank : 0;
    precision += hits / K;
    recall += rel.size ? hits / rel.size : 0;
  }

  const n = cases.length;
  console.log(`\nretrieval eval — ${n} queries, k=${K}, rerank=${useRerank ? "on" : "off"}`);
  console.log(`  MRR           ${(mrr / n).toFixed(4)}`);
  console.log(`  precision@${K}   ${(precision / n).toFixed(4)}`);
  console.log(`  recall@${K}      ${(recall / n).toFixed(4)}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
