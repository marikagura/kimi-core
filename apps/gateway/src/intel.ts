import "dotenv/config";
import { numEnv } from "./lib/env.js";
import { groupByIdleGap } from "./lib/session-group.js";
import cron from "node-cron";
import prisma from "./db.js";
import { localDate, localDateTime, DEFAULT_TZ } from "./time.js";
import { embedAndStore } from "./lib/embed.js";
import { sweepNullEmbeddings } from "./lib/embedding-sweep.js";
import { writeSessionScore } from "./lib/session-score.js";
import { checkDataConcern } from "./lib/sleep-concern.js";
import { deriveConcerns, deriveDrives, decayStaleConcerns, sweepConcerns } from "./lib/concern-derive.js";
import { checkDimHealth } from "./lib/dim-health.js";
import { checkCurationHealth } from "./lib/curation-health.js";
import { roleModel } from "./lib/models.js";
import { chatCompletion } from "./lib/llm.js";
import { CHAT_SOURCE, CROSS_CHAT_SOURCE, CHAT_DIGEST_WHERE, parseChatEvent } from "@kimi/context-core";
import { firstJsonObject } from "./lib/json-extract.js";
import { parseDigest, parseSessionScore, type Digest } from "./lib/llm-schemas.js";
import { errMessage } from "./lib/err.js";

// No built-in model — every model is the deployer's own (KIMI_MODEL, with optional
// per-role overrides INTEL_MODEL / INTEL_DIGEST_MODEL / INTEL_SWEEP_MODEL /
// INTEL_SCORE_AUTHOR_MODEL). Resolved at use via roleModel(); unset → clear error.

// Optional OpenRouter-style provider routing. Comma-separated provider names in
// LLM_PROVIDER_ORDER pin the routing order; sent only when set (an OpenRouter
// extension — OpenAI-compatible endpoints that don't support it ignore the field).
const PROVIDER_ORDER = (process.env.LLM_PROVIDER_ORDER || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Digest path single source of truth:
//  - scanDialogueDigests is the only digest path; runs on an hourly tick
//    (see digestTick at the bottom of this file). It compresses each idle chat
//    session into one EPISODE memory and emits a per-session self-score (v/a).
//  - State hygiene (concern close/open) is handled by the closeout flow.
//
// CHAT_INTEL_OFF gates only extractFromChat (the legacy candidate-extraction +
// scoring pipeline); it does not gate the digest path. The flag is kept for
// easy rollback of candidate extraction.
const CHAT_INTEL_OFF = true;

const DAY_MS = 86_400_000;

// Larger intel / digest / sweep caller: shares chatCompletion (fetch + 180s
// timeout + throw) and supplies the INTEL_MODEL role default, OpenRouter provider
// routing, and optional extended thinking. (callLLMShort in lib/llm.ts is the
// lighter sibling — short default + trimmed result.)
async function callLLM(system: string, user: string, maxTokens = 2000, modelOverride?: string, thinkingTokens?: number) {
  return chatCompletion({
    system,
    user,
    model: modelOverride || roleModel("INTEL_MODEL"),
    maxTokens,
    providerOrder: PROVIDER_ORDER,
    thinkingTokens,
  });
}

function parseCandidates(response: string): any[] {
  // New format: {candidates: [...], sessionScore: {...}}
  const obj = firstJsonObject(response);
  if (obj && Array.isArray(obj.candidates)) return obj.candidates;
  // Fallback: old format (bare array)
  try {
    const arrMatch = response.match(/\[[\s\S]*\]/);
    return arrMatch ? JSON.parse(arrMatch[0]) : [];
  } catch {
    return [];
  }
}

// When the main call returns candidates=[] it often drops sessionScore too. This
// fallback is a score-only call, single task, no extraction. Triggered only on
// the failure case.
async function retrySessionScoreOnly(conversation: string): Promise<{ valence: number; arousal: number; note: string } | null> {
  const system = `Score the emotional tone of the conversation below. Output a JSON object only, no other text.

Format (all three fields required):
{"valence": -1 to 1, "arousal": 0 to 1, "note": "one-line emotional undertone"}

valence: negative = low/distant, 0 = neutral, positive = warm/close
arousal: 0 = calm, 0.5 = medium, 1 = high intensity
note: at most one short sentence`;
  const response = await callLLM(system, conversation, 300);
  return parseSessionScore(response);
}

async function getLastRun(): Promise<Date> {
  const last = await prisma.event.findFirst({
    where: { eventType: "SYSTEM", source: "intel" },
    orderBy: { createdAt: "desc" },
  });
  return last?.createdAt || new Date(Date.now() - 7 * DAY_MS);
}

async function getExistingMemoryTitles(): Promise<string> {
  const memories = await prisma.memory.findMany({
    where: { isActive: true },
    select: { title: true },
    take: 200,
    orderBy: { importance: "desc" },
  });
  return memories.map((m) => m.title).join("\n- ");
}

// Reference extractor — distils memory candidates from chat. It is the TEMPLATE
// for ANY ingestion source: clone it and swap the query/source. A real deployment
// can run parallel extractors over email / dreams / telegram / location / phone /
// calendar / … — same candidate pipeline, only the `prisma.event.findMany` source
// (and the system prompt's framing) differ. One generic chat extractor ships here;
// wiring more sources is a per-deployment choice (each source is personal).
async function extractFromChat(since: Date, existingTitles: string) {
  const chats = await prisma.event.findMany({
    where: { eventType: "CHAT", source: CHAT_SOURCE, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  if (chats.length < 4) return 0;

  const conversation = chats.map((c) => {
    const p = parseChatEvent(c.value);
    return p ? `[${p.role}] ${p.text}` : "";
  }).filter(Boolean).join("\n");

  const system = `You are the intelligence layer. Extract memory candidates from the chat conversation between the user and the assistant.

Rules:
- Extract mainly from the user's turns. What the user says is memory material.
- From assistant turns extract only explicit commits (promises, rules, findings). Do not store assistant analysis as memory.
- Always capture explicit memory markers from the user ("note this", "next time", "always do this from now on", "remember", "don't forget").

Extract:
- Newly revealed user preferences / decisions / identity info
- Recurring themes or emotions
- New information about people or projects
- New user patterns

Do not extract:
- One-off conversational detail
- Repetition of known profile facts
- Trivial functional chatter
- Explicit sensitive content (record the theme only, not the content)

Existing memories (do not duplicate):
- ${existingTitles}

Output a JSON object:
{
  "candidates": [
    {
      "title": "short title",
      "content": "what to remember",
      "type": "MEMORY_CANDIDATE",
      "priority": 1-5,
      "confidence": 1-5
    }
  ],
  "sessionScore": {
    "valence": -1 to 1,
    "arousal": 0 to 1,
    "note": "one-line emotional undertone of this conversation"
  }
}

candidates: at most 5; if nothing is worth extracting, return "candidates": [].

sessionScore is a HARD REQUIREMENT: return the full sessionScore fields whether or not candidates is empty.
Score based on everything you read (including emotional intensity), not only what you extracted.
Skipping sessionScore leaves gaps in the self_score timeline.`;

  const response = await callLLM(system, conversation);
  const candidates = parseCandidates(response);
  let score = parseSessionScore(response);

  // Main call returned no score → score-only retry.
  if (!score) {
    console.log(`[intel] chat sessionScore null in primary call, retry score-only`);
    score = await retrySessionScoreOnly(conversation);
    if (!score) {
      console.warn(`[intel] chat sessionScore failed after retry, skipping write`);
      await prisma.event.create({
        data: {
          eventType: "SYSTEM",
          source: "intel_score_failed",
          value: JSON.stringify({ branch: "chat", chats: chats.length, since: since.toISOString() }),
        },
      });
    }
  }

  let added = 0;
  for (const c of candidates) {
    await prisma.pendingItem.create({
      data: {
        pendingType: "MEMORY_CANDIDATE",
        title: c.title || "untitled",
        content: `${c.content || ""}\n\n[confidence: ${c.confidence || 3}]`,
        priority: c.priority || 3,
        sourceRefType: "chat_digest",
      },
    });
    added++;
  }

  // Memory V3 — chat session score
  if (score) {
    const today = localDate(new Date());
    await prisma.memory.create({
      data: {
        title: `chat-score ${today}`,
        summary: score.note,
        content: score.note,
        memoryType: "SELF_SCORE",
        experiencer: "SELF",
        // Self-score is a snapshot, not an open question — default RESOLVED.
        resolution: "RESOLVED",
        valence: score.valence,
        arousal: score.arousal,
        importance: 3,
        sourceType: "CHAT",
        authorModel: roleModel("INTEL_SCORE_AUTHOR_MODEL"),
      },
    });
    console.log(`[intel] chat session score: v=${score.valence} a=${score.arousal} "${score.note}"`);
  }

  return added;
}


async function scanSelfEmotion(): Promise<{ created: number; updated: number; deactivated: number; swept: string }> {
  // self-concern v2: concerns are no longer minted by an arousal>0.6 numeric gate.
  // Concerns are produced upstream (diary content flag, DATA probes, manual/backfill
  // writes of Memory(SELF) with a concernKey). This pass does maintenance + close +
  // projection:
  //   1. decay: OPEN EVIDENCE/SUBJECTIVE that has not moved → EASING (DATA does not decay;
  //      its probe owns it)
  //   2. sweep: LLM judges OPEN/EASING concerns resolved/active/linger, writes back resolution
  //   3. derive: Memory(SELF concern) with a concernKey → ActiveState (single writer)
  //
  // Keyless OPEN memories are not auto-assigned a key — legacy mis-OPEN junk (e.g. a
  // rule-update note) would otherwise surface as a concern. A real concern must be
  // tagged explicitly by the write site (diary/probe/state_set) or selectively by
  // backfill; junk is RESOLVED directly.

  const decayed = await decayStaleConcerns();
  if (decayed) console.log(`[self-emotion] decayed ${decayed} stale OPEN concern(s) → EASING`);

  // LLM close pass, runs daily before derive so close results project the same round.
  // Conservative (leans linger when unsure). Uses extended thinking; maxTokens leaves
  // output headroom (thinking counts toward total, must be < maxTokens).
  let swept = "skip";
  try {
    const verdicts = await sweepConcerns((s, u) => callLLM(s, u, 2000, roleModel("INTEL_SWEEP_MODEL"), 1500));
    if (verdicts.length) {
      const appliedN = verdicts.filter((v) => v.applied).length;
      swept = `${verdicts.length} judged [${verdicts.map((v) => `${v.key}:${v.verdict}`).join(", ")}] ${appliedN} applied`;
      console.log(`[self-sweep] ${swept}`);
    } else {
      swept = "0 sweepable";
    }
  } catch (e: unknown) {
    const m = errMessage(e);
    console.error("self-sweep err:", m);
    swept = `ERR ${m}`;
  }

  const d = await deriveConcerns();
  console.log(`[self-emotion] derive: ${d.upserted} active, ${d.deactivated} deactivated, keys=[${d.keys.join(",")}]`);

  const dd = await deriveDrives();
  console.log(`[self-drive] derive: ${dd.upserted} active, ${dd.deactivated} deactivated, keys=[${dd.keys.join(",")}]`);

  return { created: d.upserted, updated: decayed, deactivated: d.deactivated, swept };
}

// Topic-judge criterion embedded into the digest prompt. Neutral default; ships
// without any persona-specific wordlist. Override via env to route digests into
// a topic slug of your own scheme.
const TOPIC_JUDGE_CRITERION = process.env.INTEL_TOPIC_CRITERION || "";
const TOPIC_SLUG = process.env.INTEL_TOPIC_SLUG || "";

// Dialogue digest layer — scans CHAT events in a recent window, groups them into
// sessions by an idle gap, and compresses each session into one EPISODE memory.
// dedup via title prefix (date-based); the first run backfills recent history.
//
// Runs once per chat source: the primary CHAT_SOURCE always, plus the cross
// surface (a second front end) only when GROUND_CROSS_CHAT_SOURCE is configured.
// srcTag disambiguates the per-session title + score dedup so two surfaces' same-
// time sessions never collide; the primary's srcTag is "" so existing titles stay
// stable (no history re-digest).
export type DigestSource = { source: string; srcTag: string };
export const DIGEST_SOURCES: DigestSource[] = [
  { source: CHAT_SOURCE, srcTag: "" },
  ...(process.env.GROUND_CROSS_CHAT_SOURCE ? [{ source: CROSS_CHAT_SOURCE, srcTag: ` ·${CROSS_CHAT_SOURCE}` }] : []),
];
export async function scanDialogueDigests(
  cutoffStart?: Date,
  cutoffEnd?: Date,
  source: string = CHAT_SOURCE,
  srcTag: string = "",
): Promise<{ created: number; skipped: number; failed: number }> {
  const now = Date.now();
  // No fixed lag; completeness is enforced by the session idle gate below.
  const _cutoffEnd = cutoffEnd ?? new Date(now);
  // 7-day look-back: catch recently un-digested sessions (backfill safety net).
  // Already-digested sessions are skipped by the title-date dedup.
  const _cutoffStart = cutoffStart ?? new Date(now - 7 * DAY_MS);

  const events = await prisma.event.findMany({
    where: {
      eventType: "CHAT",
      source,
      createdAt: { gte: _cutoffStart, lt: _cutoffEnd },
    },
    orderBy: { createdAt: "asc" },
  });
  if (events.length === 0) return { created: 0, skipped: 0, failed: 0 };

  // Ensure the topic row exists when topic routing is configured (the LLM may
  // place TOPIC_SLUG into suggested_topic_slug). No-op when no slug is set.
  if (TOPIC_SLUG) {
    // A chat-digest routing topic has no specific life-domain → the neutral GENERAL
    // domain (added to the Domain enum in migration 2).
    await prisma.topic.upsert({ where: { slug: TOPIC_SLUG }, update: {}, create: { slug: TOPIC_SLUG, name: TOPIC_SLUG, domain: "GENERAL" } });
  }

  // Group by session, not by calendar day. A session = a continuous conversation;
  // a gap larger than GAP_H starts a new session. events are already time-ascending.
  const GAP_H = numEnv("INTEL_SESSION_GAP_H", 4);
  const sessions = groupByIdleGap(events, GAP_H);

  let created = 0, skipped = 0, failed = 0;

  const MIN_TURNS = numEnv("INTEL_MIN_TURNS", 5);

  for (const dayEvents of sessions) {
    // idle gate: only digest once a session has been idle for GAP_H — after that,
    // any new event starts a new session and will not extend this one, so the
    // digest is safely over a complete session. Not yet idle = possibly in progress
    // → skip and wait for the next round.
    const lastE = dayEvents[dayEvents.length - 1];
    if (now - lastE.createdAt.getTime() <= GAP_H * 3600 * 1000) { skipped++; continue; }
    // dateStr = session start date in the configured local timezone (used in the title)
    const dateStr = localDate(dayEvents[0].createdAt);
    // session start time — disambiguates multiple sessions on the SAME calendar day.
    // Grouping is per-session (by idle gap), so the dedup key must be per-session too;
    // a date-only key silently drops every 2nd+ same-day session.
    const startHHMM = localDateTime(dayEvents[0].createdAt).slice(11, 16);
    // skip sparse sessions
    if (dayEvents.length < MIN_TURNS) { skipped++; continue; }

    // parse turns
    type Turn = { idx: number; line: string; event: typeof dayEvents[0] };
    const parsed: Turn[] = [];
    for (let i = 0; i < dayEvents.length; i++) {
      const e = dayEvents[i];
      const t = localDateTime(e.createdAt).slice(11, 16);
      const p = parseChatEvent(e.value);
      if (!p) continue;
      parsed.push({ idx: parsed.length, line: `[${t}] ${p.role}: ${p.text}`, event: e });
    }
    if (parsed.length < MIN_TURNS) { skipped++; continue; }

    const titlePrefix = `[chat ${dateStr} ${startHHMM}${srcTag}]`;

    // session score collected from the digest's v/a output
    let scoreV: number | null = null, scoreA: number | null = null, scoreNote = "";

    // dedup by title prefix. A fallback placeholder row (summary starting with
    // "[digest failed") is not counted as complete — delete it so this round can
    // regenerate, otherwise a failed day stays stuck forever.
    const existing = await prisma.memory.findFirst({
      where: { ...CHAT_DIGEST_WHERE, title: { startsWith: titlePrefix } },
      select: { id: true, summary: true },
    });
    if (existing) {
      if (existing.summary?.startsWith("[digest failed")) {
        await prisma.memory.delete({ where: { id: existing.id } });
      } else { skipped++; continue; }
    }

    const transcript = parsed.map((t) => t.line).join("\n").slice(0, 12000);
    const prompt = `Below is a chat conversation from ${dateStr}. Produce one episode memory.

Rules:
- Under 500 chars (floor — under-compressing is the costly error; prefer writing more).
- First-person perspective. Write what happened: who said/did what.
- If the day has clearly different moods (morning / afternoon / late night, etc.), narrate each in its own paragraph; keep the arc, do not flatten.
- If a thread is left open (an unfinished item, a worry, an unresolved emotion), append "carryover: ..." at the end of the content.
- Flat narration, short sentences. No "Summary:" opener. No filler. Write the throughline / mood / retained signals directly.
- If you quote, use 「」, not straight double quotes (" breaks the output JSON).
- Do not transcribe the raw conversation; write the undertone.

Conversation:
${transcript}

Output JSON (JSON only, no markdown fence):
{
  "summary": "...",
  "valence": -1 to 1 overall mood, null if no clear affect,
  "arousal": 0 to 1 overall intensity, null if none,
  "suggested_topic_slug": null or a topic slug string.${TOPIC_JUDGE_CRITERION ? ` Topic criterion: ${TOPIC_JUDGE_CRITERION} If matched, set "${TOPIC_SLUG}".` : ""}
}`;

    const systemPrompt = "You are a conversation digest agent. Be conservative; do not flatten. Write in the first person.";
    try {
      // Retry once on failure (network / JSON parse / refusal).
      let raw = "";
      let p: Digest | null = null;
      let attempts = 0;
      for (attempts = 1; attempts <= 2; attempts++) {
        try {
          raw = await callLLM(systemPrompt, prompt, 1500, roleModel("INTEL_DIGEST_MODEL"));
        } catch (err: unknown) {
          console.warn(`[dialogue_digest] ${dateStr} callLLM attempt ${attempts} threw: ${errMessage(err)}`);
          raw = "";
        }
        p = parseDigest(raw);
        if (p) break;
        if (attempts < 2) {
          console.warn(`[dialogue_digest] ${dateStr} attempt ${attempts} no summary (raw_len=${raw.length}), retrying`);
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      if (!p) {
        // Both attempts failed (refusal / non-JSON / empty) → do not write a fake
        // row to pollute the pool. Skip this session; the next tick's dedup finds
        // nothing and re-runs automatically.
        console.warn(`[dialogue_digest] ${dateStr} failed twice, skipping (retry next round). raw[0..200]=${raw.slice(0, 200)}`);
        failed++;
        continue;
      }

      if (p.valence !== null) {
        scoreV = p.valence;
        scoreA = p.arousal;
        scoreNote = p.summary.split("\n")[0].slice(0, 120);
      }

      let topicId: string | null = null;
      if (p.suggested_topic_slug) {
        const t = await prisma.topic.findUnique({ where: { slug: p.suggested_topic_slug } });
        if (t) topicId = t.id;
      }

      const dContent = p.summary.slice(0, 2000);
      const dSummary = p.summary.slice(0, 200);
      const firstEvent = parsed[0].event;
      const lastEvent = parsed[parsed.length - 1].event;
      const digestMem = await prisma.memory.create({
        data: {
          ...CHAT_DIGEST_WHERE,
          title: titlePrefix,
          content: dContent,
          summary: dSummary,
          importance: 2,
          valence: p.valence,
          arousal: p.arousal,
          topicId,
          eventIdStart: firstEvent.id,
          eventIdEnd: lastEvent.id,
          digestTimeStart: firstEvent.createdAt,
          digestTimeEnd: lastEvent.createdAt,
          // validFrom = when the conversation actually happened. The folds anchor
          // recency on validFrom (not write time); the 7-day backfill writes old
          // sessions today, so without this their drive recency would read as "now".
          validFrom: lastEvent.createdAt,
        },
        select: { id: true },
      });
      await embedAndStore("memories", digestMem.id, `${titlePrefix}\n${dSummary}`);
      created++;
    } catch (err: unknown) {
      console.error(`[dialogue_digest] ${dateStr} failed:`, errMessage(err));
      failed++;
    }

    // session self-score from the digest's v/a. dedup by title.
    if (scoreV !== null) {
      await writeSessionScore({
        dateStr,
        startHHMM,
        srcTag,
        valence: scoreV,
        arousal: scoreA,
        note: scoreNote,
        firstAt: dayEvents[0].createdAt,
        lastAt: dayEvents[dayEvents.length - 1].createdAt,
      });
    }
  }

  return { created, skipped, failed };
}

async function runAll() {
  const ts = localDateTime(new Date());
  console.log(`[${ts}] running intelligence...`);
  const since = await getLastRun();
  const existingTitles = await getExistingMemoryTitles();
  console.log(`since ${localDateTime(since)}, ${existingTitles.split("\n").length} existing memories`);

  const summary: string[] = [];
  if (CHAT_INTEL_OFF) {
    summary.push("chat: candidate extraction OFF (digest+score via scanDialogueDigests hourly tick)");
  } else {
    try {
      const n = await extractFromChat(since, existingTitles);
      summary.push(`chat: ${n} candidates`);
    } catch (e: unknown) { const m = errMessage(e); console.error("chat err:", m); summary.push(`chat: ERR ${m}`); }
  }
  // probe must run before scanSelfEmotion(derive): derive projects SELF memory
  // (incl. sleep_debt) into ActiveState. Running the probe afterward would make
  // state lag a round (derive reads the previous round's memory). Probe first,
  // derive projects → state is current this round.
  try {
    const r = await checkDataConcern();
    summary.push(`data_concern: ${r.concerned ? "ACTIVE" : "ok"} avg=${r.avgValue.toFixed(1)} short=${r.shortWindows} windows=${r.windows}`);
  } catch (e: unknown) { const m = errMessage(e); console.error("sleep_concern err:", m); summary.push(`sleep_concern: ERR ${m}`); }

  try {
    const r = await scanSelfEmotion();
    summary.push(`self_emotion: +${r.created} created, ${r.updated} updated, ${r.deactivated} deactivated; sweep: ${r.swept}`);
  } catch (e: unknown) { const m = errMessage(e); console.error("self_emotion err:", m); summary.push(`self_emotion: ERR ${m}`); }

  // Dead-dimension probe: a full-dimension grounding roster goes into the summary
  // for the ops dashboard. Isolated in lib/dim-health.ts and wrapped in try so a
  // failure only drops this one summary line, never the main flow.
  try {
    const r = await checkDimHealth();
    summary.push(`dim_health: ${r.roster.map((d) => `${d.key}=${d.grounding.toFixed(2)}${d.dark ? "(!)" : ""}`).join(" ")}`);
  } catch (e: unknown) { const m = errMessage(e); console.error("dim_health err:", m); summary.push(`dim_health: ERR ${m}`); }

  // Curation-health probe: the append-only store needs human curation (no auto-
  // consolidation by design). Surfaces the manual-review pool + a nudge when it
  // piles up, so a deployment without a backstage UI still gets reminded. Wrapped
  // in try so a failure only drops this summary line, never the main flow.
  try {
    const r = await checkCurationHealth();
    summary.push(`curation: active=${r.activeTotal} high-imp=${r.highImportance} open-concerns=${r.openConcerns}${r.flags.length ? ` (!) ${r.flags.join(",")}` : ""}`);
  } catch (e: unknown) { const m = errMessage(e); console.error("curation_health err:", m); summary.push(`curation: ERR ${m}`); }
  // dialogue_digest runs on its own hourly tick (digestTick, below): a session is
  // digested once it has been idle for GAP_H. It is not run here to avoid a
  // concurrent dedup collision with the tick. This is the only digest path.
  try {
    const r = await sweepNullEmbeddings();
    summary.push(`embedding_sweep: ${r.patched}/${r.attempted} patched`);
  } catch (e: unknown) { const m = errMessage(e); console.error("embedding_sweep err:", m); summary.push(`embedding_sweep: ERR ${m}`); }

  // Auto-expire PendingItem after 7 days: candidates nobody resolves accumulate
  // forever. Items still OPEN after 7 days → EXPIRED. Still visible in backstage,
  // but no longer part of the active backlog.
  try {
    const cutoff = new Date(Date.now() - 7 * DAY_MS);
    const expired = await prisma.pendingItem.updateMany({
      where: {
        status: "OPEN",
        createdAt: { lt: cutoff },
      },
      data: { status: "EXPIRED", resolvedAt: new Date() },
    });
    summary.push(`pending_expire: ${expired.count} expired (>7d OPEN)`);
  } catch (e: unknown) {
    const m = errMessage(e);
    console.error("pending_expire err:", m);
    summary.push(`pending_expire: ERR ${m}`);
  }

  // intel push is disabled. High-priority pending items stay in the DB (visible
  // in backstage); email push goes through the scheduler allowlist.
  summary.push("push: disabled");

  await prisma.event.create({
    data: {
      eventType: "SYSTEM",
      source: "intel",
      value: `Intel run:\n${summary.join("\n")}`,
    },
  });
  console.log(summary.join("\n"));
}

// Daily run time is config-driven. Default 09:00 local: keeps the daily decay→sweep
// →derive pass current before downstream consumers read concern/drive state.
if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is not set. See .env.example.");
  process.exit(1);
}
const DAILY_CRON = process.env.INTEL_DAILY_CRON || "0 9 * * *";
const CRON_TZ = process.env.KIMI_CRON_TZ ?? DEFAULT_TZ;
// Wrap so a rejected run (e.g. DB unavailable at cold start) is a logged error, not
// an unhandled rejection that crashes the long-lived intel process.
const safeRunAll = () => runAll().catch((e: unknown) => console.error("[intel] runAll error:", errMessage(e)));
cron.schedule(DAILY_CRON, safeRunAll, { timezone: CRON_TZ });
void safeRunAll();

// dialogue_digest hourly tick — a session is digested once it has been idle for
// GAP_H. A concurrency lock prevents a second run starting before the previous
// one finishes (the LLM can be slow with many sessions). With no ready session
// it skips in milliseconds.
const DIGEST_CRON = process.env.INTEL_DIGEST_CRON || "15 * * * *";
let digestRunning = false;
async function digestTick() {
  if (digestRunning) { console.log("[digest tick] skip — previous round still running"); return; }
  digestRunning = true;
  try {
    let created = 0, skipped = 0, failed = 0;
    for (const src of DIGEST_SOURCES) {
      const r = await scanDialogueDigests(undefined, undefined, src.source, src.srcTag);
      created += r.created; skipped += r.skipped; failed += r.failed;
    }
    if (created > 0 || failed > 0) {
      console.log(`[digest tick] +${created} created, ${skipped} skipped, ${failed} failed`);
    }
  } catch (e: unknown) { console.error("[digest tick] err:", errMessage(e)); }
  finally { digestRunning = false; }
}
const safeDigestTick = () => digestTick().catch((e: unknown) => console.error("[intel] digestTick error:", errMessage(e)));
cron.schedule(DIGEST_CRON, safeDigestTick, { timezone: CRON_TZ });
void safeDigestTick();

console.log(`intel started. runAll cron=${DAILY_CRON} ${CRON_TZ}; dialogue_digest cron=${DIGEST_CRON}.`);
