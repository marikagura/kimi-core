// Depth judge — single source of truth. Reused in three places, so it never
// drifts:
//   (c) backfill (historical batch tagging)
//   (a1) auto-digest (embedded into the digest prompt's suggested-topic stanza)
//   (a2) closeout / memory_write async fallback (fire-and-forget after the hot
//        path writes, so a missed manual tag still gets caught)
//
// "Depth" = the user opens up a layer of their own world (vs. a routine,
// system-logged entry). The criterion text and example templates below are
// intentionally neutral and config-driven — the upstream application supplies
// its own domain language. Only edit the criterion here.
import prisma from "../db.js";
import { callLLMShort } from "./llm.js";
import { roleModel } from "./models.js";
import { firstJsonObject } from "./json-extract.js";
import { errMessage } from "./err.js";

// Topic slug used to mark depth memories across all write paths. Tunable. Exported
// as the single definition — concern-derive's bonding-dim backing imports it.
export const DEPTH_TOPIC_SLUG = process.env.DEPTH_TOPIC_SLUG ?? "depth-topic";
// Judge model: DEPTH_JUDGE_MODEL env, else the shared KIMI_MODEL. No built-in default.

// One-line version — embedded into another prompt (the digest's existing
// topic-suggestion stanza).
export const DEPTH_JUDGE_CRITERION = `Depth = the person opens up a layer of their own world (self-disclosure) — sharing something personal, revising how they see themselves, or thinking a concept through together. Not depth: system / email / API auto-logged entries (calendar, orders, reminders, routing) and pure task delivery (shipping, reviews, bug fixes, architecture).`;

// Full SYSTEM — standalone batch judging (backfill). Returns {"depth":[indices]}
export const DEPTH_JUDGE_SYSTEM = `You judge whether a memory is "depth" — the person opening up a layer of their own world. Sharing itself is relationship.
Is depth: they voluntarily disclose a layer of themselves — how they see their own situation, a revision in self-understanding, a vulnerability, how they manage their own affairs, their creative self, or the two of you thinking an idea all the way through together. Whether the content is emotional or practical or conceptual — if it is the person sharing, showing you their world, it counts.
Not depth: system / email / API auto-logged entries (calendar, purchase orders, reminders, routing tables) and pure task delivery (shipping, reviews, bug fixes, architecture plans).
Criterion: is this "the person opening themselves up to you", or "the system logging an entry on their behalf"? The former is depth.
Return pure JSON only, no explanation: {"depth":[indices]}`;

// Single-item SYSTEM — fallback (judge one memory right after the hot path
// writes it). Returns {"depth":true/false}
export const DEPTH_JUDGE_ONE_SYSTEM = `You judge whether a memory is "depth" — the person opening up a layer of their own world. Sharing itself is relationship.
${DEPTH_JUDGE_CRITERION}
Criterion: is this "the person opening themselves up to you", or "the system logging an entry on their behalf"? The former is depth.
Return pure JSON only, no explanation: {"depth":true} or {"depth":false}`;

// (a2) hot-path fallback: closeout / memory_write fire-and-forget after writing
// one memory. Only catches "eligible memories with no topic" — a manually
// tagged depth topic is skipped (the manual tag is the main path; this only
// guards against forgetting). Same judge as backfill, fire-and-forget so it
// never blocks the hot path, swallows all errors so it never touches the main
// write.
export async function tagDepthIfNeeded(mem: {
  id: string; title: string; content: string; memoryType: string; importance: number; topicId: string | null;
}): Promise<void> {
  try {
    if (mem.topicId) return;                                   // already tagged (manual / other topic) — don't overwrite
    if (mem.importance < 4) return;                            // only catch important enough ones
    if (!["CORE", "EPISODE"].includes(mem.memoryType)) return; // only the two types depth can land in
    const user = `[${mem.memoryType}] ${mem.title} — ${mem.content.slice(0, 220).replace(/\s+/g, " ")}`;
    const raw = await callLLMShort(DEPTH_JUDGE_ONE_SYSTEM, user, { model: roleModel("DEPTH_JUDGE_MODEL"), maxTokens: 30 });
    const isDepth = firstJsonObject(raw)?.depth === true;
    if (!isDepth) return;
    const topic = await prisma.topic.upsert({
      where: { slug: DEPTH_TOPIC_SLUG },
      update: {},
      // The depth topic is generic self-disclosure, not a specific life-domain →
      // the neutral GENERAL domain (added to the Domain enum in migration 2).
      create: { slug: DEPTH_TOPIC_SLUG, name: DEPTH_TOPIC_SLUG, domain: "GENERAL" },
    });
    await prisma.memory.update({ where: { id: mem.id }, data: { topicId: topic.id } });
    console.log(`[depth-tag] fallback tagged depth: ${mem.title.slice(0, 40)}`);
  } catch (e: unknown) {
    console.warn(`[depth-tag] fallback skipped (does not affect main write): ${errMessage(e)}`);
  }
}
