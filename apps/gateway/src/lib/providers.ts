// Reference delivery providers — concrete, generic implementations of the two
// pluggable seams the engine otherwise ships as no-ops:
//   * the daemon's Notifier (outward push)            → setNotifier(getNotifier())
//   * WEBSEARCH's SearchProvider (curiosity search)   → ActionContext.search
// Both are env-driven and provider-agnostic. They ship OFF by default
// (NOTIFIER / SEARCH_PROVIDER default to a no-op), so wiring them changes nothing
// until a deployment opts in. Nothing here decides *whether* to notify or search
// — that stays the agent's decision plus the AUTONOMY_MODE gate.

import type { Notifier, Notification } from "../daemon.js"; // type-only: no daemon side effects at import
import { NoopSearchProvider, type SearchProvider, type SearchResult } from "./agency.js";
import { fetchWithRetry } from "../fetch-retry.js";

// ── Notifier ────────────────────────────────────────────────────────────────

// Logs to stdout — the minimal real notifier, for local runs / testing.
export const ConsoleNotifier: Notifier = {
  async send(n: Notification) {
    console.log(`[notify] ${n.priority ?? "normal"} ${n.slug}: ${n.content}`);
  },
};

// POSTs the notification as JSON to NOTIFIER_WEBHOOK_URL. The body is a generic
// shape ({<field>: content, slug, priority}); NOTIFIER_WEBHOOK_FIELD remaps the
// content key to whatever your endpoint expects (e.g. "text" for Slack, "message"
// for ntfy, "content" for Discord). Network failures are logged, never thrown —
// a failed push must not crash the wake loop.
export class WebhookNotifier implements Notifier {
  constructor(
    private url: string,
    private field: string = process.env.NOTIFIER_WEBHOOK_FIELD || "content",
  ) {}
  async send(n: Notification): Promise<void> {
    const body: Record<string, unknown> = { slug: n.slug, priority: n.priority ?? "normal" };
    body[this.field] = n.content;
    try {
      const res = await fetchWithRetry(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) console.warn(`[notify] webhook ${res.status} for ${n.slug}`);
    } catch (err) {
      console.warn(`[notify] webhook failed for ${n.slug}: ${(err as Error)?.message ?? err}`);
    }
  }
}

// Factory: NOTIFIER = none (default) | console | webhook.
//   none / console → log to stdout (same observable behavior as the daemon's
//     built-in no-op, so wiring this in is safe by default)
//   webhook        → POST to NOTIFIER_WEBHOOK_URL (falls back to console if unset)
export function getNotifier(): Notifier {
  const kind = (process.env.NOTIFIER || "none").trim().toLowerCase();
  if (kind === "webhook") {
    const url = process.env.NOTIFIER_WEBHOOK_URL;
    if (url) return new WebhookNotifier(url);
    console.warn("[notify] NOTIFIER=webhook but NOTIFIER_WEBHOOK_URL unset → console");
  }
  return ConsoleNotifier;
}

// ── SearchProvider ───────────────────────────────────────────────────────────

// Pluck the results array (SEARCH_RESULTS_PATH, a dot-path, default "results")
// and map each item's fields (SEARCH_FIELD_TITLE / _URL / _SNIPPET) into a
// SearchResult. Configurable so it adapts to most JSON search APIs (Brave /
// Tavily / SerpAPI / your own) with no code change. Pure — unit-tested.
export function mapResults(json: unknown): SearchResult[] {
  const path = (process.env.SEARCH_RESULTS_PATH || "results").split(".");
  let arr: unknown = json;
  for (const k of path) arr = (arr as Record<string, unknown> | null | undefined)?.[k];
  if (!Array.isArray(arr)) return [];
  const tF = process.env.SEARCH_FIELD_TITLE || "title";
  const uF = process.env.SEARCH_FIELD_URL || "url";
  const sF = process.env.SEARCH_FIELD_SNIPPET || "snippet";
  return arr
    .map((r: unknown): SearchResult => {
      const o = r as Record<string, unknown>;
      return {
        title: String(o?.[tF] ?? ""),
        url: o?.[uF] ? String(o[uF]) : undefined,
        snippet: String(o?.[sF] ?? ""),
      };
    })
    .filter((r) => r.title || r.snippet);
}

// GET {SEARCH_API_URL}?{SEARCH_QUERY_PARAM=q}=<query>, optional
// `Authorization: Bearer <SEARCH_API_KEY>`, JSON response mapped by mapResults.
export class HttpSearchProvider implements SearchProvider {
  name = "http";
  async search(query: string): Promise<SearchResult[]> {
    const base = process.env.SEARCH_API_URL;
    if (!base) return [];
    const qp = process.env.SEARCH_QUERY_PARAM || "q";
    const url = `${base}${base.includes("?") ? "&" : "?"}${qp}=${encodeURIComponent(query)}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (process.env.SEARCH_API_KEY) headers.authorization = `Bearer ${process.env.SEARCH_API_KEY}`;
    const res = await fetchWithRetry(url, { headers });
    if (!res.ok) throw new Error(`search API ${res.status}`);
    return mapResults(await res.json());
  }
}

// Factory: SEARCH_PROVIDER = none (default) | http. http needs SEARCH_API_URL.
export function getSearchProvider(): SearchProvider {
  const kind = (process.env.SEARCH_PROVIDER || "none").trim().toLowerCase();
  if (kind === "http" && process.env.SEARCH_API_URL) return new HttpSearchProvider();
  return NoopSearchProvider;
}
