// Paper source adapters. A "source" fetches recent papers from an academic index.
//
// PubMedAdapter (NCBI E-utilities) is the REFERENCE implementation. To use this
// extension in your own field, either reconfigure it (pubMedAdapter({ query: ... })
// with your field's E-utilities term + optional journal whitelist) OR swap in a
// different source entirely (arXiv, bioRxiv, Crossref, Semantic Scholar, or any
// site) by implementing SourceAdapter. Nothing here is field-specific except the
// config you pass in.

import { fetchWithRetry } from "../../fetch-retry.js";

export interface PaperHit {
  /** Source-specific id (e.g. a PubMed UID). Used as the dedup key. */
  externalId: string;
  title: string;
  authors?: string;
  journal?: string;
  url?: string;
  /** ISO-ish date string as the source returns it. */
  publishedAt?: string;
  abstract?: string;
}

export interface SourceAdapter {
  name: string;
  /** Fetch recent papers matching the adapter's configured query. */
  fetchRecent(opts?: { days?: number }): Promise<PaperHit[]>;
}

// ── PubMed (NCBI E-utilities) reference adapter ─────────────────────────────
export interface PubMedConfig {
  /** E-utilities `term` — YOUR field's query. The example wired in loop.ts is
   *  intentionally generic; replace it with your domain's search. */
  query: string;
  /** Optional: keep only hits whose journal name contains one of these
   *  (case-insensitive substring). Omit to keep everything. */
  journalWhitelist?: string[];
  /** Look-back window in days. */
  days?: number;
  /** Max ids per fetch. */
  retmax?: number;
}

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

// Minimal shape of an NCBI esummary `result[uid]` entry (only the fields read here).
// `error` is present on a per-UID error stub (e.g. { uid, error: "cannot get
// document summary" }) for suppressed/retracted/embargoed UIDs that esearch lists.
type ESummaryArticle = {
  uid?: string | number;
  title?: string;
  authors?: Array<{ name?: string }>;
  fulljournalname?: string;
  source?: string;
  pubdate?: string;
  error?: string;
};

export function pubMedAdapter(cfg: PubMedConfig): SourceAdapter {
  return {
    name: "pubmed",
    async fetchRecent(opts) {
      const days = opts?.days ?? cfg.days ?? 7;
      const retmax = cfg.retmax ?? 30;

      // esearch → id list (most recent first)
      const searchUrl =
        `${EUTILS}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(cfg.query)}` +
        `&reldate=${days}&datetype=pdat&retmode=json&retmax=${retmax}&sort=pub_date`;
      const sres = await fetchWithRetry(searchUrl);
      if (!sres.ok) throw new Error(`pubmed esearch ${sres.status}`);
      const sdata = (await sres.json()) as { esearchresult?: { idlist?: string[] } };
      const ids: string[] = sdata.esearchresult?.idlist ?? [];
      if (!ids.length) return [];

      // esummary → article metadata
      const sumUrl = `${EUTILS}/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json`;
      const ures = await fetchWithRetry(sumUrl);
      if (!ures.ok) throw new Error(`pubmed esummary ${ures.status}`);
      const udata = (await ures.json()) as { result?: Record<string, ESummaryArticle> };

      const wl = cfg.journalWhitelist?.map((j) => j.toLowerCase());
      return ids
        .map((id) => udata.result?.[id])
        // Drop missing entries AND per-UID error stubs / entries with no usable
        // title or uid: otherwise an error stub becomes a PaperHit with title "" and
        // externalId "undefined" (every later stub then dedups to that one row,
        // masking real fetch gaps) and wastes an LLM distill() call.
        .filter((a): a is ESummaryArticle => Boolean(a) && !a!.error && a!.uid != null && Boolean(a!.title))
        .filter((a) => {
          if (!wl?.length) return true;
          const journal = (a.fulljournalname || a.source || "").toLowerCase();
          return wl.some((j) => journal.includes(j));
        })
        .map((a): PaperHit => ({
          externalId: String(a.uid),
          title: a.title || "",
          authors: (a.authors || []).map((x) => x.name).slice(0, 5).join(", "),
          journal: a.fulljournalname || a.source || undefined,
          url: `https://pubmed.ncbi.nlm.nih.gov/${a.uid}/`,
          publishedAt: a.pubdate || undefined,
        }));
    },
  };
}
