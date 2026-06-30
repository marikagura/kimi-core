// ============================================================================
// Cold-start injection filters — externalized config.
//
// reentry / reentry_delta build cold-start context (also reached by background
// daemons). Some rows should not enter that injection: e.g. pure technical
// noise, or any content classes a deployment chooses to keep out of cold start.
//
// The MECHANISM (prefix filtering, title filtering, a content predicate) lives
// in the tool code. The actual lists / predicates are deployment-private, so
// they are supplied here and ship NEUTRAL: empty lists and a no-op predicate.
// Override these to match your own tagging scheme (env / config / a private
// build that replaces this module).
// ============================================================================

/**
 * Memory/observation titles that are pure technical noise and should not be
 * injected into cold-start context (still reachable via memory_search).
 * Ships empty — populate for your own scheme.
 */
export const TECH_ONLY_TITLES: string[] = [];

/**
 * Title prefixes whose rows are excluded from cold-start injection (any content
 * class your deployment tags by prefix). Ships empty.
 */
export const COLD_START_EXCLUDE_PREFIXES: string[] = [];

/**
 * Title substrings whose rows are excluded from cold-start injection.
 * Ships empty.
 */
export const COLD_START_EXCLUDE_SUBSTRINGS: string[] = [];

/**
 * Content predicate gating cold-start injection. Return true to EXCLUDE a row
 * (e.g. it matches a class your deployment excludes). Ships as a no-op (never
 * excludes) so the engine runs with no denylist. Override to wire a
 * deployment-specific classifier.
 */
export function coldStartExcludeContent(_text: string): boolean {
  return false;
}

/**
 * True if a row should be kept OUT of cold-start injection given its title /
 * content. Combines the prefix / substring / title lists and the content
 * predicate above. With the neutral defaults this always returns false.
 */
export function isColdStartExcluded(title: string | null | undefined, text: string): boolean {
  const t = title ?? "";
  if (TECH_ONLY_TITLES.some((x) => t.includes(x))) return true;
  if (COLD_START_EXCLUDE_PREFIXES.some((p) => t.startsWith(p))) return true;
  if (COLD_START_EXCLUDE_SUBSTRINGS.some((s) => t.includes(s))) return true;
  if (coldStartExcludeContent(text)) return true;
  return false;
}

/**
 * Content predicate for the public-facing safe search (memory_search_safe).
 * Return true to DROP a hit because it carries content a third-party / public
 * client must not see. Ships as a no-op (never drops) so the engine runs
 * without a private denylist. Override to wire your own public denylist.
 */
export function publicSearchDrop(_text: string): boolean {
  return false;
}
