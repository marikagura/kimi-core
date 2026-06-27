// Weekly arc — an opt-in scheduled extension. Once a week it rolls the week's
// memories (episodes, new anchors, the self-score curve, concerns, state changes,
// dreams) into a short first-person narrative "arc" and writes it back as one
// SHARED EPISODE memory — so meaning accumulates somewhere, not only raw event
// history. The LLM arc is the top half; a stats appendix is the fallback if the
// model call fails, so the weekly note is never lost.
//
// Two ways to run it:
//   - manual:     npm run weekly:arc
//   - scheduled:  enable the extension (KIMI_EXTENSIONS=weekly-arc) and set
//                 WEEKLY_ARC_CRON (e.g. "0 22 * * 0" — Sunday 22:00) — the daemon
//                 then runs runWeeklyArc on that cron.
//
// The arc's voice comes from your persona (buildPersona / persona.md — see
// persona.example.md) prepended to ARC_SCAFFOLD below. The scaffold is a FLAT
// DEMO TEMPLATE: it ships neutral, carries no one's register, and is meant to be
// filled in (a persona + your own edits), not run as-is.

import "dotenv/config";
import { fileURLToPath } from "node:url";
import prisma from "../../db.js";
import { buildPersona } from "@kimi/context-core";
import { callLLMShort } from "../../lib/llm.js";
import { roleModel } from "../../lib/models.js";
import { errMessage } from "../../lib/err.js";
import { DEFAULT_TZ } from "../../time.js";

const TZ = process.env.KIMI_CRON_TZ || DEFAULT_TZ;

// ── arc scaffold — A FLAT DEMO TEMPLATE, not a working voice ──────────────────
// Ships neutral and carries no one's register. The arc's voice comes from your
// persona (buildPersona, configured via persona.md — see persona.example.md),
// prepended to this scaffold; the scaffold itself only holds the structural craft
// (flat narrative, carryover ending, no clichés). With no persona configured and
// no edits, this produces a generic placeholder arc — a demo meant to be filled
// in, not run as-is. Supply a persona + edit ARC_SCAFFOLD to make it yours.
const ARC_SCAFFOLD = `You are writing a short weekly narrative — an "arc", not a report. Connect this week's episodes into one flat, first-person narrative (about 200–400 words): where things stood at the start of the week, where they ended, and the turning points between. Let the week's different threads — work, relationships, whatever the material holds — show how they intertwine. If the material contains one or two especially heavy lines, you may quote them (only if present — never invent). End on what is still open (the carryover), not on a conclusion. Avoid: summarizing clichés, aphorisms, tidy "this week taught us" wrap-ups, and parallel-construction verdicts that fold two things into one sentence. Write only what is in the material; when unsure, leave it out. Output the arc body only — no title, no preamble.`;

// Voice = your persona (the empty default until you configure persona.md) + the
// scaffold above. No persona → a generic arc; this stays a demo until filled in.
function buildArcSystem(): string {
  const persona = buildPersona({ surface: "tg", registersText: "" }).trim();
  return persona ? `${persona}\n\n${ARC_SCAFFOLD}` : ARC_SCAFFOLD;
}

// ── week window ──────────────────────────────────────────────────────────────
export function isoWeekKey(d: Date, tz: string = TZ): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const day = new Date(`${p}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((day.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

const fmtDate = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, month: "2-digit", day: "2-digit" }).format(d);

export type WeekData = {
  weekKey: string;
  weekStart: Date;
  weekEnd: Date;
  episodes: Array<{ title: string; summary: string | null; importance: number; createdAt: Date }>;
  anchors: Array<{ title: string; memoryType: string; importance: number }>;
  selfScores: Array<{ title: string; content: string; valence: number | null; arousal: number | null; createdAt: Date }>;
  concerns: Array<{ title: string }>;
  stateChanges: Array<{ stateType: string; title: string; startAt: Date; endAt: Date | null }>;
  dreamCount: number;
  gardenAdded: number;
};

export async function gatherWeekData(weekStart: Date, weekEnd: Date): Promise<WeekData> {
  const inWeek = { gte: weekStart, lt: weekEnd };

  const episodes = await prisma.memory.findMany({
    where: {
      memoryType: "EPISODE",
      createdAt: inWeek,
      isActive: true,
      NOT: [{ title: { startsWith: "weekly arc" } }], // an arc never eats an arc
    },
    select: { title: true, summary: true, importance: true, createdAt: true },
    orderBy: [{ importance: "desc" }, { createdAt: "asc" }],
    take: 30,
  });

  const anchors = await prisma.memory.findMany({
    where: { memoryType: { in: ["CORE", "BOUNDARY", "PREFERENCE"] }, createdAt: inWeek, isActive: true },
    select: { title: true, memoryType: true, importance: true },
    orderBy: { createdAt: "asc" },
    take: 15,
  });

  const selfScores = await prisma.memory.findMany({
    where: { memoryType: "SELF_SCORE", createdAt: inWeek, isActive: true },
    select: { title: true, content: true, valence: true, arousal: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const concerns = await prisma.activeState.findMany({
    where: { stateType: "SELF_CONCERN", isActive: true },
    select: { title: true },
  });

  const stateChanges = await prisma.$queryRaw<
    Array<{ stateType: string; title: string; startAt: Date; endAt: Date | null }>
  >`
    SELECT "stateType"::text AS "stateType", title, "startAt", "endAt"
    FROM active_state
    WHERE ("startAt" >= ${weekStart} AND "startAt" < ${weekEnd})
       OR ("endAt" >= ${weekStart} AND "endAt" < ${weekEnd})
    ORDER BY "startAt" ASC
    LIMIT 20
  `;

  const dreamCount = await prisma.event.count({ where: { eventType: "DREAM", createdAt: inWeek } });
  const gardenAdded = await prisma.pwaKv.count({ where: { namespace: "garden", createdAt: inWeek } });

  return {
    weekKey: isoWeekKey(new Date(weekEnd.getTime() - 86_400_000)),
    weekStart,
    weekEnd,
    episodes,
    anchors,
    selfScores,
    concerns,
    stateChanges,
    dreamCount,
    gardenAdded,
  };
}

// ── the material handed to the model ─────────────────────────────────────────
export function buildDataBlock(data: WeekData): string {
  const L: string[] = [];
  L.push(`Week ${data.weekKey} (${fmtDate(data.weekStart)} → ${fmtDate(data.weekEnd)}).`);
  L.push("");
  L.push(`## episodes (by importance)`);
  for (const e of data.episodes) {
    L.push(`- [${fmtDate(e.createdAt)} imp${e.importance}] ${e.title}${e.summary ? ` — ${e.summary.slice(0, 200)}` : ""}`);
  }
  if (data.anchors.length) {
    L.push("", `## new anchors (CORE / BOUNDARY / PREFERENCE)`);
    for (const a of data.anchors) L.push(`- [${a.memoryType} imp${a.importance}] ${a.title}`);
  }
  if (data.selfScores.length) {
    L.push("", `## self-score curve (v = valence, a = arousal)`);
    for (const s of data.selfScores) {
      L.push(`- [${fmtDate(s.createdAt)}] ${s.title} v=${s.valence ?? "?"} a=${s.arousal ?? "?"}: ${s.content.slice(0, 120)}`);
    }
  }
  if (data.stateChanges.length) {
    L.push("", `## state changes`);
    for (const s of data.stateChanges) {
      const closed = s.endAt && s.endAt >= data.weekStart && s.endAt < data.weekEnd;
      L.push(`- [${s.stateType}] ${closed ? "closed" : "opened"}: ${s.title}`);
    }
  }
  return L.join("\n");
}

export function buildStatsBlock(data: WeekData): string {
  const L: string[] = [];
  L.push(`## appendix · stats`);
  L.push(`window ${fmtDate(data.weekStart)} → ${fmtDate(data.weekEnd)}`);
  if (data.anchors.length) {
    L.push(`new anchors: ${data.anchors.map((a) => `[${a.memoryType}] ${a.title}`).join(" · ")}`);
  }
  L.push(`episodes ${data.episodes.length} · dreams ${data.dreamCount} · state Δ ${data.stateChanges.length} · garden +${data.gardenAdded}`);
  if (data.concerns.length) {
    L.push(`active concerns: ${data.concerns.map((c) => c.title).join(" / ")}`);
  }
  return L.join("\n");
}

// ── write the arc back as one SHARED EPISODE memory (deduped by week) ─────────
export async function writeArcMemory(
  data: WeekData,
  arcText: string | null,
  authorModel: string | null,
): Promise<{ written: boolean; deduped: boolean }> {
  const title = `weekly arc ${data.weekKey}`;
  const existing = await prisma.memory.findFirst({ where: { title, isActive: true }, select: { id: true } });
  if (existing) return { written: false, deduped: true };

  const stats = buildStatsBlock(data);
  const content = arcText ? `${arcText.trim()}\n\n---\n\n${stats}` : stats;
  const summary = arcText
    ? arcText.trim().slice(0, 280)
    : `week ${data.weekKey}: ${data.episodes.length} episodes / ${data.dreamCount} dreams (arc generation failed, stats only)`;

  await prisma.memory.create({
    data: {
      title,
      content,
      summary,
      memoryType: "EPISODE",
      sourceType: "EVENT",
      importance: 4,
      experiencer: "SHARED",
      authorModel,
      validFrom: new Date(data.weekEnd.getTime() - 1), // anchor at the week's end
    },
  });
  return { written: true, deduped: false };
}

async function generateArc(data: WeekData): Promise<{ text: string | null; model: string }> {
  const model = roleModel("WEEKLY_ARC_MODEL");
  try {
    const text = await callLLMShort(buildArcSystem(), buildDataBlock(data), { model, maxTokens: 1500 });
    return { text: text.trim().length > 50 ? text.trim() : null, model };
  } catch (e: unknown) {
    console.error("[weekly-arc] generate failed:", errMessage(e));
    return { text: null, model };
  }
}

export async function runWeeklyArc(): Promise<{ weekKey: string; episodeCount: number; written: boolean }> {
  const now = new Date();
  const weekStart = new Date(now.getTime() - 7 * 86_400_000);
  const data = await gatherWeekData(weekStart, now);
  const { text, model } = await generateArc(data);
  const res = await writeArcMemory(data, text, text ? model : null);
  console.log(
    res.deduped
      ? `[weekly-arc] ${data.weekKey} already exists, skipped`
      : `[weekly-arc] ${data.weekKey} written (arc=${text ? "ok" : "fallback-stats"}, ${data.episodes.length} episodes)`,
  );
  return { weekKey: data.weekKey, episodeCount: data.episodes.length, written: res.written };
}

// CLI entry — only when run directly (not when imported by the extension).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runWeeklyArc()
    .then(() => process.exit(0))
    .catch((e: unknown) => {
      console.error("[weekly-arc] error:", errMessage(e));
      process.exit(1);
    });
}
