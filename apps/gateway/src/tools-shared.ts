// ============================================================================
// Shared helpers for the split tool registries (tools-*.ts).
// renderAnchor / SELF_CONCERN_DEFAULTS / StateTypeName / upsertActiveState
// were private to tools.ts; they are exported here so each domain registry
// can import the exact same definitions.
// ============================================================================

import prisma from "./db.js";

// Anchor body rendering, shared by reentry / reentry_delta. Softens by type +
// importance: BOUNDARY → full body (the rule body is the rule; slicing breaks
// it). CORE importance=5 → full body (identity signature / commitments /
// relationship frame must not lose its tail). CORE importance<=4 + all
// PREFERENCE → summary || slice(500) (analytical content; 500 chars keeps the
// first half of the arc).
export function renderAnchor(m: any): string {
  if (m.memoryType === "BOUNDARY") return m.content;
  if (m.memoryType === "CORE" && m.importance === 5) return m.content;
  const fallback = m.content.length > 500 ? m.content.slice(0, 500) + "..." : m.content;
  return m.summary || fallback;
}

// Fields shared by every SELF_CONCERN → Memory(SELF) write (state_set + closeout).
// The per-site fields (title/summary/content, sourceType MANUAL↔CHAT, concernKey,
// authorModel) stay explicit at each call so provenance can't silently drift.
export const SELF_CONCERN_DEFAULTS = {
  memoryType: "STATE",
  importance: 4,
  experiencer: "SELF",
  grounding: "SUBJECTIVE",
  resolution: "OPEN",
  valence: -0.3,
  arousal: 0.4,
} as const;

export type StateTypeName = "HEALTH" | "MOOD" | "PROJECT" | "STRESS" | "RELATIONSHIP" | "SCHEDULE" | "SELF_CONCERN";

// (stateType + title) upsert, scoped to isActive rows: an existing active state of
// the same title is updated; otherwise a new active row is created. The isActive
// scope is load-bearing — a previously-closed same-title state must NOT be revived,
// so this is not a plain prisma.upsert (no unique key backs it). Shared by state_set
// and closeout; returns whether a row was created (vs updated) for the caller's message.
export async function upsertActiveState(args: {
  stateType: StateTypeName;
  title: string;
  summary: string;
  content: string;
  source?: string;
}): Promise<{ created: boolean }> {
  const { stateType, title, summary, content, source } = args;
  const existing = await prisma.activeState.findFirst({
    where: { stateType, title, isActive: true },
    select: { id: true },
  });
  if (existing) {
    await prisma.activeState.update({ where: { id: existing.id }, data: { summary, content, source } });
    return { created: false };
  }
  await prisma.activeState.create({ data: { stateType, title, summary, content, source } });
  return { created: true };
}
