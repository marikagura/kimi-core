import "dotenv/config";
import cron from "node-cron";
import prisma from "./db.js";
import { Prisma } from "@prisma/client";
import { localDate, localDateTime, DEFAULT_TZ } from "./time.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { embedText, embedAndStore, writeEmbedding, STALE_EMBEDDING_WHERE } from "./lib/embed.js";
import { checkDataConcern } from "./lib/sleep-concern.js";
import { deriveConcerns, deriveDrives, decayStaleConcerns, sweepConcerns } from "./lib/concern-derive.js";
import { checkDimHealth } from "./lib/dim-health.js";
import { roleModel } from "./lib/models.js";
import { CHAT_SOURCE, CHAT_DIGEST_WHERE, parseChatEvent } from "@kimi/context-core";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY!;
// No built-in model — every model is the deployer's own (KIMI_MODEL, with optional
// per-role overrides INTEL_MODEL / INTEL_DIGEST_MODEL / INTEL_SWEEP_MODEL /
// INTEL_SCORE_AUTHOR_MODEL). Resolved at use via roleModel(); unset → clear error.

// Optional OpenRouter provider routing preference. Comma-separated provider names
// in OPENROUTER_PROVIDER_ORDER pin the routing order; unset → no explicit order,
// only allow_fallbacks (OpenRouter picks).
const PROVIDER_ORDER = (process.env.OPENROUTER_PROVIDER_ORDER || "")
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

async function callLLM(system: string, user: string, maxTokens = 2000, modelOverride?: string, thinkingTokens?: number) {
  const res = await fetchWithRetry("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelOverride || roleModel("INTEL_MODEL"),
      // Apply a provider routing preference only for Anthropic models, so passing a
      // non-Anthropic override later does not force a provider on it. Order is taken
      // from OPENROUTER_PROVIDER_ORDER when set; otherwise only allow_fallbacks.
      ...((!modelOverride || modelOverride.startsWith("anthropic/")) && {
        provider: { ...(PROVIDER_ORDER.length && { order: PROVIDER_ORDER }), allow_fallbacks: true },
      }),
      // Extended thinking (used by self-sweep). thinkingTokens must be < maxTokens
      // (thinking counts toward total). Omitted → no thinking; existing calls unaffected.
      ...(thinkingTokens && { reasoning: { max_tokens: thinkingTokens } }),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
    }),
  });
  const data = (await res.json()) as any;
  return data.choices?.[0]?.message?.content || "";
}

function parseCandidates(response: string): any[] {
  try {
    // Try new format: {candidates: [...], sessionScore: {...}}
    const objMatch = response.match(/\{[\s\S]*\}/);
    if (objMatch) {
      const obj = JSON.parse(objMatch[0]);
      if (Array.isArray(obj.candidates)) return obj.candidates;
    }
    // Fallback: old format (bare array)
    const arrMatch = response.match(/\[[\s\S]*\]/);
    if (!arrMatch) return [];
    return JSON.parse(arrMatch[0]);
  } catch {
    return [];
  }
}

function parseSessionScore(response: string): { valence: number; arousal: number; note: string } | null {
  try {
    const objMatch = response.match(/\{[\s\S]*\}/);
    if (!objMatch) return null;
    const obj = JSON.parse(objMatch[0]);
    // Main call wraps as { sessionScore: {...} }; retry call returns {valence, arousal, note} bare.
    const score = obj.sessionScore ?? obj;
    if (score && typeof score.valence === "number" && typeof score.arousal === "number") {
      return { valence: score.valence, arousal: score.arousal, note: score.note ?? "" };
    }
    return null;
  } catch {
    return null;
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
  return last?.createdAt || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

async function getExistingMemoryTitles(): Promise<string> {
  const memories = await prisma.memory.findMany({
    where: { isActive: true },
    select: { title: true },
    take: 200,
    orderBy: { importance: "desc" },
  });
  return memories.map((m: any) => m.title).join("\n- ");
}

async function extractFromChat(since: Date, existingTitles: string) {
  const chats = await prisma.event.findMany({
    where: { eventType: "CHAT", source: CHAT_SOURCE, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  if (chats.length < 4) return 0;

  const conversation = chats.map((c: any) => {
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
  } catch (e: any) {
    console.error("self-sweep err:", e.message);
    swept = `ERR ${e.message}`;
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
export async function scanDialogueDigests(
  cutoffStart?: Date,
  cutoffEnd?: Date,
): Promise<{ created: number; skipped: number; failed: number }> {
  const now = Date.now();
  // No fixed lag; completeness is enforced by the session idle gate below.
  const _cutoffEnd = cutoffEnd ?? new Date(now);
  // 7-day look-back: catch recently un-digested sessions (backfill safety net).
  // Already-digested sessions are skipped by the title-date dedup.
  const _cutoffStart = cutoffStart ?? new Date(now - 7 * 24 * 3600 * 1000);

  const events = await prisma.event.findMany({
    where: {
      eventType: "CHAT",
      source: CHAT_SOURCE,
      createdAt: { gte: _cutoffStart, lt: _cutoffEnd },
    },
    orderBy: { createdAt: "asc" },
  });
  if (events.length === 0) return { created: 0, skipped: 0, failed: 0 };

  // Ensure the topic row exists when topic routing is configured (the LLM may
  // place TOPIC_SLUG into suggested_topic_slug). No-op when no slug is set.
  if (TOPIC_SLUG) {
    await prisma.topic.upsert({ where: { slug: TOPIC_SLUG }, update: {}, create: { slug: TOPIC_SLUG, name: TOPIC_SLUG, domain: "GENERAL" as any } });
  }

  // Group by session, not by calendar day. A session = a continuous conversation;
  // a gap larger than GAP_H starts a new session. events are already time-ascending.
  const GAP_H = Number(process.env.INTEL_SESSION_GAP_H || 4);
  const sessions: (typeof events)[] = [];
  for (const e of events) {
    const cur = sessions[sessions.length - 1];
    const prevE = cur?.[cur.length - 1];
    if (!cur || e.createdAt.getTime() - prevE!.createdAt.getTime() > GAP_H * 3600 * 1000) {
      sessions.push([e]);
    } else {
      cur.push(e);
    }
  }

  let created = 0, skipped = 0, failed = 0;

  const MIN_TURNS = Number(process.env.INTEL_MIN_TURNS || 5);

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

    const titlePrefix = `[chat ${dateStr} ${startHHMM}]`;

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
      let p: any = {};
      let attempts = 0;
      for (attempts = 1; attempts <= 2; attempts++) {
        try {
          raw = await callLLM(systemPrompt, prompt, 1500, roleModel("INTEL_DIGEST_MODEL"));
        } catch (err: any) {
          console.warn(`[dialogue_digest] ${dateStr} callLLM attempt ${attempts} threw: ${err?.message ?? err}`);
          raw = "";
        }
        const match = raw.match(/\{[\s\S]*\}/);
        try { p = match ? JSON.parse(match[0]) : {}; } catch { p = {}; }
        if (p.summary) break;
        if (attempts < 2) {
          console.warn(`[dialogue_digest] ${dateStr} attempt ${attempts} no summary (raw_len=${raw.length}), retrying`);
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      if (!p.summary) {
        // Both attempts failed (refusal / non-JSON / empty) → do not write a fake
        // row to pollute the pool. Skip this session; the next tick's dedup finds
        // nothing and re-runs automatically.
        console.warn(`[dialogue_digest] ${dateStr} failed twice, skipping (retry next round). raw[0..200]=${raw.slice(0, 200)}`);
        failed++;
        continue;
      }

      if (typeof p.valence === "number") {
        scoreV = p.valence;
        scoreA = typeof p.arousal === "number" ? p.arousal : null;
        scoreNote = String(p.summary).split("\n")[0].slice(0, 120);
      }

      let topicId: string | null = null;
      if (p.suggested_topic_slug && typeof p.suggested_topic_slug === "string") {
        const t = await prisma.topic.findUnique({ where: { slug: p.suggested_topic_slug } });
        if (t) topicId = t.id;
      }

      const dContent = String(p.summary).slice(0, 2000);
      const dSummary = String(p.summary).slice(0, 200);
      const firstEvent = parsed[0].event;
      const lastEvent = parsed[parsed.length - 1].event;
      const digestMem = await prisma.memory.create({
        data: {
          ...CHAT_DIGEST_WHERE,
          title: titlePrefix,
          content: dContent,
          summary: dSummary,
          importance: 2,
          valence: typeof p.valence === "number" ? p.valence : null,
          arousal: typeof p.arousal === "number" ? p.arousal : null,
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
    } catch (err: any) {
      console.error(`[dialogue_digest] ${dateStr} failed:`, err.message);
      failed++;
    }

    // session self-score from the digest's v/a. dedup by title.
    if (scoreV !== null) {
      const scoreTitle = `chat-score ${dateStr} ${startHHMM}`;
      const existsScore = await prisma.memory.findFirst({
        where: { memoryType: "SELF_SCORE", title: scoreTitle },
        select: { id: true },
      });
      if (!existsScore) {
        try {
          await prisma.memory.create({
            data: {
              memoryType: "SELF_SCORE",
              title: scoreTitle,
              summary: scoreNote || `${dateStr} session`,
              content: scoreNote || `${dateStr} session`,
              importance: 3,
              experiencer: "SELF",
              resolution: "RESOLVED",
              valence: scoreV,
              arousal: scoreA,
              sourceType: "CHAT",
              authorModel: roleModel("INTEL_SCORE_AUTHOR_MODEL"),
              digestTimeStart: dayEvents[0].createdAt,
              digestTimeEnd: dayEvents[dayEvents.length - 1].createdAt,
              validFrom: dayEvents[dayEvents.length - 1].createdAt,
            },
          });
        } catch (err: any) {
          console.error(`[dialogue_digest] ${dateStr} self-score write failed:`, err.message);
        }
      }
    }
  }

  return { created, skipped, failed };
}

// Sweep memories with NULL embedding (any reason: provider down when the memory
// was written, key missing, backfill never ran, a schema push dropped then
// re-added the column leaving rows NULL).
// Limit 500/run — cost-bounded enough to one-shot a backfill.
// Same discipline extended to two more tables (observations + core_profile),
// which were previously only covered by a one-off migrate script.
async function sweepNullEmbeddings(): Promise<{ patched: number; attempted: number }> {
  let patched = 0, attempted = 0;
  // 1. embedding IS NULL — newly written or cleared
  // 2. updatedAt > createdAt + 1min AND embeddingAt < updatedAt — content was
  //    edited but the embedding did not follow
  const rows: any[] = await prisma.$queryRaw(Prisma.sql`
    SELECT id, title, content, summary FROM memories
    WHERE "isActive" = true AND (${STALE_EMBEDDING_WHERE})
    LIMIT 500
  `);
  attempted += rows.length;
  for (const m of rows) {
    const emb = await embedText(`${m.title}\n${m.summary || m.content}`);
    if (!emb) continue;
    await writeEmbedding("memories", m.id, emb);
    patched++;
  }
  // observations: upsert is frequent (unique key); embeddingAt < updatedAt means
  // content changed but the embedding did not. Raw UPDATE does not bump Prisma's
  // @updatedAt, so the sweep does not push updatedAt forward and will not self-trigger.
  const obsRows: any[] = await prisma.$queryRaw(Prisma.sql`
    SELECT id, title, content FROM observations
    WHERE "isActive" = true AND (${STALE_EMBEDDING_WHERE})
    LIMIT 100
  `);
  attempted += obsRows.length;
  for (const o of obsRows) {
    const emb = await embedText(`${o.title}\n${o.content}`);
    if (!emb) continue;
    await writeEmbedding("observations", o.id, emb);
    patched++;
  }
  const profRows: any[] = await prisma.$queryRaw(Prisma.sql`
    SELECT id, title, content FROM core_profile
    WHERE "isActive" = true AND (${STALE_EMBEDDING_WHERE})
    LIMIT 100
  `);
  attempted += profRows.length;
  for (const c of profRows) {
    const emb = await embedText(`${c.title}\n${c.content}`);
    if (!emb) continue;
    await writeEmbedding("core_profile", c.id, emb);
    patched++;
  }
  return { patched, attempted };
}

// Truncate to max chars, preferring a clean sentence boundary. If the last
// punctuation mark lands within the first 60% of the window, that cut would
// lose too much — fall back to a hard cut with "…".
function cleanTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastPunct = Math.max(
    cut.lastIndexOf("。"),
    cut.lastIndexOf("！"),
    cut.lastIndexOf("？"),
    cut.lastIndexOf(". "),
    cut.lastIndexOf("! "),
    cut.lastIndexOf("? "),
  );
  if (lastPunct > max * 0.6) return cut.slice(0, lastPunct + 1);
  return cut + "…";
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
    } catch (e: any) { console.error("chat err:", e.message); summary.push(`chat: ERR ${e.message}`); }
  }
  // probe must run before scanSelfEmotion(derive): derive projects SELF memory
  // (incl. sleep_debt) into ActiveState. Running the probe afterward would make
  // state lag a round (derive reads the previous round's memory). Probe first,
  // derive projects → state is current this round.
  try {
    const r = await checkDataConcern();
    summary.push(`data_concern: ${r.concerned ? "ACTIVE" : "ok"} avg=${r.avgValue.toFixed(1)} short=${r.shortWindows} windows=${r.windows}`);
  } catch (e: any) { console.error("sleep_concern err:", e.message); summary.push(`sleep_concern: ERR ${e.message}`); }

  try {
    const r = await scanSelfEmotion();
    summary.push(`self_emotion: +${r.created} created, ${r.updated} updated, ${r.deactivated} deactivated; sweep: ${r.swept}`);
  } catch (e: any) { console.error("self_emotion err:", e.message); summary.push(`self_emotion: ERR ${e.message}`); }

  // Dead-dimension probe: a full-dimension grounding roster goes into the summary
  // for the ops dashboard. Isolated in lib/dim-health.ts and wrapped in try so a
  // failure only drops this one summary line, never the main flow.
  try {
    const r = await checkDimHealth();
    summary.push(`dim_health: ${r.roster.map((d) => `${d.key}=${d.grounding.toFixed(2)}${d.dark ? "(!)" : ""}`).join(" ")}`);
  } catch (e: any) { console.error("dim_health err:", e.message); summary.push(`dim_health: ERR ${e.message}`); }
  // dialogue_digest runs on its own hourly tick (digestTick, below): a session is
  // digested once it has been idle for GAP_H. It is not run here to avoid a
  // concurrent dedup collision with the tick. This is the only digest path.
  try {
    const r = await sweepNullEmbeddings();
    summary.push(`embedding_sweep: ${r.patched}/${r.attempted} patched`);
  } catch (e: any) { console.error("embedding_sweep err:", e.message); summary.push(`embedding_sweep: ERR ${e.message}`); }

  // Auto-expire PendingItem after 7 days: candidates nobody resolves accumulate
  // forever. Items still OPEN after 7 days → EXPIRED. Still visible in backstage,
  // but no longer part of the active backlog.
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const expired = await prisma.pendingItem.updateMany({
      where: {
        status: "OPEN",
        createdAt: { lt: cutoff },
      },
      data: { status: "EXPIRED", resolvedAt: new Date() },
    });
    summary.push(`pending_expire: ${expired.count} expired (>7d OPEN)`);
  } catch (e: any) {
    console.error("pending_expire err:", e.message);
    summary.push(`pending_expire: ERR ${e.message}`);
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
const DAILY_CRON = process.env.INTEL_DAILY_CRON || "0 9 * * *";
const CRON_TZ = process.env.KIMI_CRON_TZ ?? DEFAULT_TZ;
cron.schedule(DAILY_CRON, runAll, { timezone: CRON_TZ });
runAll();

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
    const r = await scanDialogueDigests();
    if (r.created > 0 || r.failed > 0) {
      console.log(`[digest tick] +${r.created} created, ${r.skipped} skipped, ${r.failed} failed`);
    }
  } catch (e: any) { console.error("[digest tick] err:", e.message); }
  finally { digestRunning = false; }
}
cron.schedule(DIGEST_CRON, digestTick, { timezone: CRON_TZ });
digestTick();

console.log(`intel started. runAll cron=${DAILY_CRON} ${CRON_TZ}; dialogue_digest cron=${DIGEST_CRON}.`);
