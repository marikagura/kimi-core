// Entity <-> memory mention edges. Stored as rows in the generic `links` table
// with relationType="mentions", fromType="entity", toType="memory".
//
// Edges power memory_search's entity-hit boost: when a query names an entity
// (alias, English handle, even an emoji), we surface every memory mentioning
// that entity directly — no substring search of the memory body needed.
//
// Token extraction is the bridge between the two storage shapes. There is no
// aliases column on entities; aliases are encoded inline in `entity.name`,
// e.g. "Name (alias1/alias2)" or "Handle / role". extractEntityTokens parses
// these conventions into a flat token list that can be ILIKE-matched against
// memory text.

import prisma from "../db.js";

// Split paren content and parts before/after with these separators. `+` is
// included for compound names like "Org structure + 30 presenters".
const SEPARATORS = /[\/、,+]+/;

function isLikelyValidToken(s: string): boolean {
  if (!s) return false;
  // Pure digits: years / counts / id numbers — would overmatch every date in
  // every memory ("2026" matches every entry from this year). Skip.
  if (/^[0-9]+$/.test(s)) return false;
  if (s.length >= 2) return true;

  // 1-char tokens: only allow if they're outside the CJK ideograph block and
  // not bare ASCII alnum. Catches an emoji (which can uniquely identify an
  // entity) while rejecting a single CJK ideograph (would match unrelated
  // compounds everywhere).
  const cp = s.codePointAt(0);
  if (cp === undefined) return false;
  if (cp >= 0x4e00 && cp <= 0x9fff) return false; // CJK unified
  if (cp >= 0x3040 && cp <= 0x30ff) return false; // hiragana/katakana
  if (cp >= 0xac00 && cp <= 0xd7af) return false; // hangul
  if (/^[a-zA-Z0-9]$/.test(s)) return false;
  return true;
}

// Split a string at CJK<->ASCII script boundaries so a mixed name like
// "ab文字" becomes ["ab", "文字"]. Pure single-script strings pass
// through unchanged — "Given Name" stays one token, a CJK-only name stays one
// token. This catches the descriptive-name pattern where a memory mentions
// only part of the alias.
function splitScriptBoundary(s: string): string[] {
  const hasCJK = /[一-鿿]/.test(s);
  const hasASCII = /[a-zA-Z]/.test(s);
  if (!hasCJK || !hasASCII) return [s];
  return s.split(/(?<=[一-鿿])(?=[a-zA-Z])|(?<=[a-zA-Z])(?=[一-鿿])/);
}

export function extractEntityTokens(entityName: string): string[] {
  const tokens = new Set<string>();
  // Pull every parenthesized group out as alias candidates.
  const parens = [...entityName.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]);
  const mainPart = entityName.replace(/\([^)]+\)/g, "").trim();

  for (const part of [mainPart, ...parens]) {
    if (!part) continue;
    // Separator split survives entity names like "Handle / role" and also
    // alias groups like "alias1/alias2" inside the parens.
    for (const raw of part.split(SEPARATORS)) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      for (const seg of splitScriptBoundary(trimmed)) {
        const t = seg.trim();
        if (isLikelyValidToken(t)) tokens.add(t);
      }
    }
  }
  return [...tokens];
}

// Insert (entity, memory, "mentions") edge if it doesn't already exist. We
// avoid Prisma's link.upsert because there's no unique index on the natural
// key — relying on a SELECT-then-INSERT keeps the schema unconstrained while
// still being idempotent for sweep / backfill callers.
async function upsertMentionEdge(entityId: string, memoryId: string): Promise<boolean> {
  const existing = await prisma.link.findFirst({
    where: {
      fromType: "entity",
      fromId: entityId,
      toType: "memory",
      toId: memoryId,
      relationType: "mentions",
    },
    select: { id: true },
  });
  if (existing) return false;
  await prisma.link.create({
    data: {
      fromType: "entity",
      fromId: entityId,
      toType: "memory",
      toId: memoryId,
      relationType: "mentions",
      weight: 1.0,
      confidence: 0.9,
    },
  });
  return true;
}

type EntityWithMatchers = { id: string; name: string; matchers: RegExp[] };

// Cache the active entity list briefly so a backfill loop doesn't query
// entities once per memory. 60s is plenty — entity churn is hand-edited and
// rare. Tokens are compiled to regexes once and stored with the row.
let entityCache: { rows: EntityWithMatchers[]; fetchedAt: number } | null = null;
const ENTITY_TTL_MS = 60_000;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ASCII tokens use \b…\b so a short token like "Ame" doesn't fire on
// "came/name/frame". CJK + emoji + mixed tokens use substring because regex \b
// is defined over the ASCII word class [A-Za-z0-9_] and would refuse to match
// anywhere inside pure-CJK text.
function tokenMatcher(token: string): RegExp {
  const isPureAscii = /^[\x20-\x7f]+$/.test(token);
  if (isPureAscii) {
    return new RegExp(`\\b${escapeRegex(token)}\\b`, "i");
  }
  return new RegExp(escapeRegex(token), "i");
}

async function activeEntities(): Promise<EntityWithMatchers[]> {
  if (entityCache && Date.now() - entityCache.fetchedAt < ENTITY_TTL_MS) {
    return entityCache.rows;
  }
  const raw = await prisma.entity.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true },
  });
  const rows = raw.map((r) => ({
    ...r,
    matchers: extractEntityTokens(r.name).map(tokenMatcher),
  }));
  entityCache = { rows, fetchedAt: Date.now() };
  return rows;
}

export function clearEntityCache() {
  entityCache = null;
}

// For each active entity, decide if any of its tokens appears in the memory's
// title+summary+content. Returns the entity IDs that match.
export async function findMentionedEntities(memoryText: string): Promise<string[]> {
  const entities = await activeEntities();
  const hits: string[] = [];
  for (const e of entities) {
    for (const re of e.matchers) {
      if (re.test(memoryText)) {
        hits.push(e.id);
        break;
      }
    }
  }
  return hits;
}

// Sweep one memory: find mentioned entities, write missing edges. Returns
// the number of edges newly created (0 on a re-run for unchanged memory).
// Idempotent — backfill loops can call repeatedly without doubling rows.
export async function sweepMemoryMentions(memoryId: string): Promise<number> {
  const m = await prisma.memory.findUnique({
    where: { id: memoryId },
    select: { title: true, summary: true, content: true, isActive: true },
  });
  if (!m || !m.isActive) return 0;
  const text = [m.title, m.summary ?? "", m.content].join("\n");
  const entityIds = await findMentionedEntities(text);
  let created = 0;
  for (const eid of entityIds) {
    if (await upsertMentionEdge(eid, memoryId)) created++;
  }
  return created;
}
