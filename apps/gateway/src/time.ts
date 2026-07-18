// Re-exported from the canonical implementation in @kimi/context-core so the
// gateway and context-core share ONE timezone definition (KIMI_TZ, default
// Asia/Shanghai). These were two hand-copies that drifted (the gateway one gained
// localWeekday/tzOffsetMs; the context-core one lagged) — now there is one source.
// Gateway code keeps importing from "./time.js" as before.
export { DEFAULT_TZ, localDate, localDateTime, localWeekday, tzOffsetMs } from "@kimi/context-core";

import { localDate, localDateTime } from "@kimi/context-core";

// Provenance span for a memory's dialogue source range, rendered after the body
// as a compact marker. start required; end optional (single-sided spans allowed).
// Same-day end prints time only; cross-day end prints the full datetime.
//   both, same day:  ⟦src 2026-07-15 04:12 → 06:30⟧
//   both, cross day: ⟦src 2026-07-15 23:50 → 2026-07-16 01:20⟧
//   start only:      ⟦src 2026-07-15 04:12⟧
export function srcSpan(start: Date, end?: Date | null): string {
  const s = localDateTime(start);
  if (!end) return `⟦src ${s}⟧`;
  const e = localDate(start) === localDate(end) ? localDateTime(end).split(" ")[1] : localDateTime(end);
  return `⟦src ${s} → ${e}⟧`;
}
