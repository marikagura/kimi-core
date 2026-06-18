// ============================================================================
// Reproducible retrieval eval — `npm run eval [path/to/retrieval_cases.json]`
//
// Loads labeled cases and runs each query through `scoreMemories` — the SAME
// hybrid scorer `memory_search` calls (one DRY scorer, see lib/retrieval.ts), so
// a regression here implies a real user-visible regression. Reports, overall and
// broken down by case `kind`:
//
//   hit@5 / hit@10   — did a relevant doc land in the top 5 / top 10
//   MRR              — mean reciprocal rank of the first relevant hit
//   nDCG@10          — are the relevant docs near the TOP, not just present
//   set-recall@10    — for "whole-picture" cases: did the WHOLE set come back
//                      (redundancy ≠ completeness)
//   expectNone       — negative control: an irrelevant query must return nothing
//
// Numbers you can re-run on your own data.
//
// Labeling is by KEYWORD predicate, not by fixed row-ids: a case lists the words
// a relevant doc must contain (title/summary/content). This makes the set
// portable — you label what a good answer *says*, not which uuid it is, so the
// set survives re-seeding the DB. Bring your own: copy retrieval_cases.example.json
// to retrieval_cases.json (gitignored) and label your own.
//
// Two entry points:
//   * CLI:     npm run eval           (verbose, writes one trend Event)
//              npm run eval -- sem=off kw=off bm25=on rerank=on scope=full no-event
//   * module:  import { runEval }      — call it from a daemon/cron to log
//              metrics over time and alert on regressions (see the regression
//              note at the bottom; the delivery channel is yours to wire).
//
// On each run it writes one Event (eventType=SYSTEM, source="retrieval_eval")
// carrying the headline numbers, so a trend builds up in the event log
// (`npm run eval:history` reads it back). Pass `no-event` / EVAL_WRITE_EVENT=0
// to suppress.
//
// The pure metric functions (dcg / ndcgAt10 / coverageOf / mrr / evalCase /
// matches) are exported and unit-tested without a DB (run.test.ts).
// ============================================================================

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import prisma from "../db.js";
import { scoreMemories, getLastMaxSem, type Components } from "../lib/retrieval.js";

// A labeled case. `kind` is a free-form bucket for per-category breakdown.
export type EvalCase = {
  kind: string;
  query: string;
  // Single-target relevance: a returned doc is relevant iff its text contains
  // ANY of these keywords (case-insensitive). Drives hit@k / MRR / nDCG@10.
  expectKeywords?: string[];
  // Negative control: this query SHOULD return nothing. Passes iff zero results.
  expectNone?: boolean;
  // Whole-picture (coverage) case: each member is a keyword-set (aliases) for ONE
  // document that should be in the answer. A member is "covered" if SOME returned
  // doc matches it. Metric = set-recall@K = covered/total — measures whether the
  // WHOLE picture came back, not whether the single best doc ranked #1. Mutually
  // exclusive with expectKeywords; reported in its own aggregate.
  expectAll?: string[][];
  // Required scope. `full` cases only run when the harness runs in scope='full'
  // (they target the observation/profile/RESTRICTED pool the default scope can't
  // reach). Omitted → runs in every scope.
  scope?: "full";
  // Free-form note, ignored by the harness (handy for documenting a case).
  _note?: string;
};

export type Hit = {
  id: string;
  title: string;
  summary: string | null;
  content: string;
  final: number;
  sem: number;
  kw: number;
  via_entity: boolean;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CASES = join(__dirname, "retrieval_cases.json");
const EXAMPLE_CASES = join(__dirname, "retrieval_cases.example.json");

const LIMIT = 10;

// ── pure metric helpers (no DB; unit-tested in run.test.ts) ─────────────────

// A hit matches a keyword set if its title+summary+content contains any keyword
// (case-insensitive). memory_search surfaces all three, so a hit anywhere counts.
export function matches(hit: Hit, keywords: string[]): boolean {
  const text = `${hit.title}\n${hit.summary ?? ""}\n${hit.content}`.toLowerCase();
  return keywords.some((k) => text.includes(k.toLowerCase()));
}

// Discounted cumulative gain over a relevance vector (rels[i] for rank i+1).
export function dcg(rels: number[]): number {
  let sum = 0;
  for (let i = 0; i < rels.length; i++) sum += rels[i] / Math.log2(i + 2);
  return sum;
}

// nDCG@10 with binary relevance: a returned hit is relevant iff it matches the
// case keywords. Ideal ranking front-loads every relevant doc, so IDCG sums the
// first min(R, 10) positions where R = relevant hits in the returned top-10.
// nDCG@10 = DCG@10 / IDCG@10; 1.0 = all relevant hits sit at the top.
export function ndcgAt10(hits: Hit[], keywords: string[]): number {
  const k = Math.min(10, hits.length);
  const rels: number[] = hits.slice(0, k).map((h) => (matches(h, keywords) ? 1 : 0));
  const dcgVal = dcg(rels);
  const R = rels.reduce((a, b) => a + b, 0);
  if (R === 0) return 0;
  const ideal = Array.from({ length: Math.min(R, 10) }, () => 1);
  const idcgVal = dcg(ideal);
  return idcgVal === 0 ? 0 : dcgVal / idcgVal;
}

// set-recall@K for a coverage case: a member (keyword-set) is covered if SOME
// returned doc in top-K matches it. coverage = covered/members.
export function coverageOf(
  hits: Hit[],
  expectAll: string[][],
  k = 10,
): { members: number; covered: number; coverage: number; missing: string[] } {
  const top = hits.slice(0, k);
  let covered = 0;
  const missing: string[] = [];
  for (const memberKws of expectAll) {
    if (top.some((h) => matches(h, memberKws))) covered++;
    else missing.push(memberKws[0] ?? "?");
  }
  const members = expectAll.length;
  return { members, covered, coverage: members === 0 ? 0 : covered / members, missing };
}

export type CaseEval = {
  case: EvalCase;
  hits: Hit[];
  firstMatchRank: number; // 1-indexed; 0 = no match in top-LIMIT
  hitAt5: boolean;
  hitAt10: boolean;
  pass: boolean;
  ndcgAt10: number;
};

export function evalCase(c: EvalCase, hits: Hit[]): CaseEval {
  if (c.expectNone) {
    const noResults = hits.length === 0;
    return { case: c, hits, firstMatchRank: 0, hitAt5: noResults, hitAt10: noResults, pass: noResults, ndcgAt10: 0 };
  }
  const kws = c.expectKeywords ?? [];
  let firstRank = 0;
  for (let i = 0; i < hits.length; i++) {
    if (matches(hits[i], kws)) {
      firstRank = i + 1;
      break;
    }
  }
  return {
    case: c,
    hits,
    firstMatchRank: firstRank,
    hitAt5: firstRank >= 1 && firstRank <= 5,
    hitAt10: firstRank >= 1 && firstRank <= 10,
    pass: firstRank >= 1 && firstRank <= 10,
    ndcgAt10: ndcgAt10(hits, kws),
  };
}

export function mrr(evals: CaseEval[]): number {
  if (evals.length === 0) return 0;
  let sum = 0;
  for (const e of evals) if (e.firstMatchRank > 0) sum += 1 / e.firstMatchRank;
  return sum / evals.length;
}

// Mean nDCG@10 over the scored (non-expectNone) cases. expectNone cases have no
// relevance signal and are excluded so they don't dilute the mean.
export function meanNdcg(evals: CaseEval[]): number {
  const scored = evals.filter((e) => !e.case.expectNone);
  if (scored.length === 0) return 0;
  return scored.reduce((a, e) => a + e.ndcgAt10, 0) / scored.length;
}

export function pct(n: number, d: number): number {
  return d === 0 ? 0 : (n / d) * 100;
}

// ── harness ──────────────────────────────────────────────────────────────

async function runSearch(query: string, components?: Components, scope: "default" | "full" = "default"): Promise<Hit[]> {
  const scored = await scoreMemories(query, { limit: LIMIT, components, scope });
  return scored.map((m) => ({
    id: m.id,
    title: m.title,
    summary: m.summary,
    content: m.content ?? "",
    final: m.final,
    sem: m.sem,
    kw: m.kw,
    via_entity: !!m.via_entity,
  }));
}

export type EvalSummary = {
  total: number;
  hitAt5Pct: number;
  hitAt10Pct: number;
  mrr: number;
  ndcgAt10: number;
  byKind: Array<{ kind: string; n: number; hitAt5Pct: number; hitAt10Pct: number; mrr: number; ndcgAt10: number }>;
  failures: Array<{ kind: string; query: string; topTitle: string | null }>;
  expectNone?: { n: number; passRate: number };
  coverage?: { n: number; meanCoverage: number; fullyCovered: number };
};

async function loadCases(path?: string): Promise<EvalCase[]> {
  const tryPath = async (p: string) => JSON.parse(await readFile(p, "utf8")) as { cases: EvalCase[] };
  if (path) return (await tryPath(path)).cases;
  try {
    return (await tryPath(DEFAULT_CASES)).cases;
  } catch {
    // Fall back to the shipped example so a fresh clone runs out of the box.
    console.error(`No ${DEFAULT_CASES} — using retrieval_cases.example.json. Copy it and label your own.`);
    return (await tryPath(EXAMPLE_CASES)).cases;
  }
}

// Programmatic entry — call from a daemon/cron to log metrics over time.
// `verbose` controls per-case console logging (off for cron). `components`
// (sem/kw on/off, bm25/rerank) lets a caller A/B a scoring config by passing it
// straight through to scoreMemories; omit it to run the live default config.
export async function runEval(
  opts: { verbose?: boolean; writeEvent?: boolean; components?: Components; scope?: "default" | "full"; casesPath?: string } = {},
): Promise<EvalSummary> {
  const { verbose = false, writeEvent = true, components, scope = "default", casesPath } = opts;
  const allCases = await loadCases(casesPath);
  // Scope gate: `full`-only cases (targeting the observation/profile/RESTRICTED
  // pool the default scope can't reach) are skipped in a default run.
  const cases = allCases.filter((c) => c.scope !== "full" || scope === "full");
  if (verbose) {
    const cfg = components ? ` components=${JSON.stringify(components)}` : "";
    console.log(`# retrieval eval — ${cases.length} cases  scope=${scope}${cfg}\n`);
  }

  const evals: CaseEval[] = [];
  // Negative controls (expectNone) are tracked separately — folding a passing
  // control into hit@/MRR conflates "recall" with "control success" and inflates
  // the headline recall. They get their own pass-rate, out of the recall numbers.
  const controlEvals: CaseEval[] = [];
  const covEvals: Array<{ case: EvalCase; covered: number; members: number; coverage: number; missing: string[] }> = [];
  for (const c of cases) {
    const hits = await runSearch(c.query, components, scope);
    if (c.expectAll) {
      const cov = coverageOf(hits, c.expectAll);
      covEvals.push({ case: c, ...cov });
      if (verbose) {
        const miss = cov.missing.length ? ` miss:[${cov.missing.join(",")}]` : "";
        console.log(`▣ [${c.kind.padEnd(15)}] ${c.query.padEnd(28)} cov=${(cov.coverage * 100).toFixed(0).padStart(3)}% (${cov.covered}/${cov.members})${miss}`);
      }
      continue;
    }
    if (!c.expectKeywords?.length && !c.expectNone) {
      console.warn(`[eval] case "${c.query}" (kind=${c.kind}) has no expectKeywords / expectNone / expectAll — it scores as a permanent miss; label it.`);
    }
    const e = evalCase(c, hits);
    (c.expectNone ? controlEvals : evals).push(e);
    if (verbose) {
      const rank = e.firstMatchRank === 0 ? "—" : `r${e.firstMatchRank}`;
      console.log(`${e.pass ? "✓" : "✗"} [${c.kind.padEnd(15)}] ${c.query.padEnd(28)} ${rank.padEnd(4)} maxSem=${getLastMaxSem().toFixed(2)} ${e.pass ? "" : `(top: ${hits[0]?.title ?? "—"})`}`);
    }
  }

  const byKindMap = new Map<string, CaseEval[]>();
  for (const e of evals) {
    const arr = byKindMap.get(e.case.kind) ?? [];
    arr.push(e);
    byKindMap.set(e.case.kind, arr);
  }
  const byKind = [...byKindMap.entries()].sort().map(([kind, es]) => ({
    kind,
    n: es.length,
    hitAt5Pct: pct(es.filter((e) => e.hitAt5).length, es.length),
    hitAt10Pct: pct(es.filter((e) => e.hitAt10).length, es.length),
    mrr: mrr(es),
    ndcgAt10: meanNdcg(es),
  }));

  const total = evals.length;
  const h5 = evals.filter((e) => e.hitAt5).length;
  const h10 = evals.filter((e) => e.hitAt10).length;
  const m = mrr(evals);
  const ndcg = meanNdcg(evals);
  const failures = evals.filter((e) => !e.pass).map((e) => ({ kind: e.case.kind, query: e.case.query, topTitle: e.hits[0]?.title ?? null }));

  const covTotal = covEvals.length;
  const meanCoverage = covTotal ? covEvals.reduce((a, e) => a + e.coverage, 0) / covTotal : 0;
  const fullyCovered = covEvals.filter((e) => e.coverage >= 1).length;
  const covSuffix = covTotal ? ` cov=${(meanCoverage * 100).toFixed(0)}%` : "";

  // Negative-control pass rate — kept OUT of the hit@/MRR numbers above.
  const ctrlTotal = controlEvals.length;
  const ctrlPass = controlEvals.filter((e) => e.pass).length;
  const ctrlSuffix = ctrlTotal ? ` expectNone=${ctrlPass}/${ctrlTotal}` : "";

  if (verbose) {
    console.log("\n## by kind");
    for (const k of byKind) {
      console.log(`  ${k.kind.padEnd(15)}  n=${String(k.n).padStart(2)}  hit@5=${k.hitAt5Pct.toFixed(0).padStart(3)}%  hit@10=${k.hitAt10Pct.toFixed(0).padStart(3)}%  MRR=${k.mrr.toFixed(3)}  nDCG@10=${k.ndcgAt10.toFixed(3)}`);
    }
    console.log(`\n## overall    n=${total}  hit@5=${pct(h5, total).toFixed(0)}%  hit@10=${pct(h10, total).toFixed(0)}%  MRR=${m.toFixed(3)}  nDCG@10=${ndcg.toFixed(3)}`);
    if (covTotal) console.log(`## coverage   n=${covTotal}  set-recall@10=${(meanCoverage * 100).toFixed(0)}%  fully=${fullyCovered}/${covTotal}`);
    if (ctrlTotal) console.log(`## control    n=${ctrlTotal}  expectNone pass=${ctrlPass}/${ctrlTotal} (${pct(ctrlPass, ctrlTotal).toFixed(0)}%) — excluded from hit@/MRR`);
  }

  if (writeEvent) {
    // One trend row per run; `npm run eval:history` reads these back. Wrapped so
    // a no-DB / unreachable-DB run still prints metrics instead of crashing.
    try {
      await prisma.event.create({
        data: {
          eventType: "SYSTEM",
          source: "retrieval_eval",
          value: `retrieval_eval n=${total} hit@5=${pct(h5, total).toFixed(0)}% hit@10=${pct(h10, total).toFixed(0)}% MRR=${m.toFixed(3)} nDCG@10=${ndcg.toFixed(3)}${covSuffix}${ctrlSuffix}`,
        },
      });
    } catch (err) {
      console.warn(`[eval] could not write trend Event (DB unreachable?): ${(err as Error)?.message ?? err}`);
    }
  }

  return {
    total,
    hitAt5Pct: pct(h5, total),
    hitAt10Pct: pct(h10, total),
    mrr: m,
    ndcgAt10: ndcg,
    byKind,
    failures,
    expectNone: ctrlTotal ? { n: ctrlTotal, passRate: pct(ctrlPass, ctrlTotal) } : undefined,
    coverage: covTotal ? { n: covTotal, meanCoverage, fullyCovered } : undefined,
  };
}

// ── regression note (wiring is yours) ───────────────────────────────────────
// To watch for drift over time: schedule runEval() daily, then compare the new
// hit@10 against the rolling average of recent retrieval_eval Events and alert
// if it drops more than a few points. `regressionDrop` is the pure comparison;
// the delivery channel (push / email / log) is a surface you wire in your daemon.
export function regressionDrop(currentHitAt10: number, baselineHitAt10: number[]): number {
  if (baselineHitAt10.length === 0) return 0;
  const avg = baselineHitAt10.reduce((a, b) => a + b, 0) / baselineHitAt10.length;
  return avg - currentHitAt10;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// Optional argv: a cases path, component toggles (`sem=off kw=off bm25=on
// rerank=on`), `scope=full`, and `no-event` to skip the trend write.
function parseArgv(): { components?: Components; scope: "default" | "full"; writeEvent: boolean; casesPath?: string } {
  const flags = process.argv.slice(2);
  const comp: Components = {};
  let any = false;
  let scope: "default" | "full" = "default";
  let writeEvent = process.env.EVAL_WRITE_EVENT !== "0";
  let casesPath: string | undefined;
  for (const f of flags) {
    const m = f.match(/^(sem|kw|bm25|rerank)=(on|off|true|false)$/);
    if (m) {
      comp[m[1] as keyof Components] = m[2] === "on" || m[2] === "true";
      any = true;
    } else if (f === "scope=full") {
      scope = "full";
    } else if (f === "no-event") {
      writeEvent = false;
    } else if (!f.startsWith("-") && !f.includes("=")) {
      casesPath = f;
    }
  }
  return { components: any ? comp : undefined, scope, writeEvent, casesPath };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { components, scope, writeEvent, casesPath } = parseArgv();
  runEval({ verbose: true, writeEvent, components, scope, casesPath })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
