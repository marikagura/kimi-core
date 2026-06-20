// ============================================================================
// Closeout domain tool registry.
// closeout
// ============================================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import prisma from "./db.js";
import { localDate } from "./time.js";
import { indexNewMemory } from "./lib/memory-index.js";
import { deriveConcerns, deriveDrives, slugify } from "./lib/concern-derive.js";
import { tagDepthIfNeeded } from "./lib/depth-judge.js";
import { SELF_CONCERN_DEFAULTS, upsertActiveState } from "./tools-shared.js";

export function registerCloseoutTools(server: McpServer) {
  server.tool(
    "closeout",
    [
      "End-of-session routine. Saves an episode summary, updates active states, and logs a session-end event.",
      "Call this before a conversation window closes.",
      "",
      "Episode writing principle — layer, don't repeat:",
      "Concrete facts already written into other tables mid-session (entity/memory/observation/state/profile)",
      "get a one-line mention in the episode ('discussed X'), not an expansion. The episode records only the",
      "connections between those facts:",
      "- emotional arc: where the session started and ended, how the mood moved",
      "- relationship shift: what is different between the parties after this session",
      "- the heaviest few lines said (key quoted phrases)",
      "- carryover: threads left unresolved",
      "",
      "closeout writes the ARC only — it does NOT write CORE identity facts. Identity",
      "(who the user is, durable commitments) is written deliberately mid-session via",
      "memory_write; keyMemories cannot be CORE. The session-end event is a SYSTEM",
      "marker, not a chat turn — it never counts as the user being present.",
      "",
      "Importance rules for keyMemories:",
      "1. Pure system/technical memory → importance 3.",
      "2. Important technical progress goes in active_state(PROJECT), not memory.",
      "3. importance 4-5 only for relationship / life content.",
    ].join("\n"),
    {
      episodeTitle: z.string().describe("Title for this session episode"),
      episodeSummary: z.string().describe("This session's emotional arc + relationship trajectory. Do not repeat concrete facts already written into entity/memory/observation/state."),
      keyMemories: z
        .array(
          z.object({
            title: z.string(),
            summary: z.string().describe("Summary, <=300 chars. (1) do not repeat title (2) cover the full arc — cause / course / conclusion (3) keep the most important concrete details (numbers / names / key quoted phrases) (4) note any unresolved carryover."),
            content: z.string(),
            memoryType: z.enum(["STATE", "EPISODE", "PREFERENCE", "BOUNDARY", "RESTRICTED"]).default("EPISODE").describe("closeout never writes CORE — identity facts are written deliberately mid-session via memory_write, not bulk-dumped at closeout."),
            importance: z.number().min(1).max(5).default(3),
            topicSlug: z.string().optional(),
            valence: z.number().min(-1).max(1).optional().describe("This memory's closing valence (-1~1). Used by satiety logic to judge how the session settled."),
            bondClosure: z.boolean().optional().describe("Whether this closing settled via bonding (factual layer). Combined with valence>0 it lets the relevant drive ease off (both required)."),
          }),
        )
        .optional()
        .describe("Key memories to extract and save from this session"),
      stateUpdates: z
        .array(
          z.object({
            stateType: z.enum(["HEALTH", "MOOD", "PROJECT", "STRESS", "RELATIONSHIP", "SCHEDULE", "SELF_CONCERN"]),
            title: z.string(),
            summary: z.string().min(20).describe("Short summary >=20 chars; reentry reads only this."),
            content: z.string(),
          }),
        )
        .optional()
        .describe("Active states to set or update"),
      pendingItems: z
        .array(
          z.object({
            title: z.string(),
            content: z.string(),
            pendingType: z
              .enum(["MEMORY_CANDIDATE", "TOPIC_LINK", "DIGEST", "DIARY_NOTE", "QUEUE_MESSAGE"])
              .default("MEMORY_CANDIDATE"),
          }),
        )
        .optional()
        .describe("Items to leave pending for next session review"),
      keyObservations: z
        .array(
          z.object({
            subject: z.enum(["user", "self"]).describe("Observation subject — the user or the assistant"),
            key: z.string().describe("Unique key (snake_case), used for upsert."),
            title: z.string(),
            content: z.string(),
            importance: z.number().min(1).max(5).default(3),
            author: z.string().optional().describe("Who recorded the observation. Default 'assistant'"),
          }),
        )
        .optional()
        .describe("Structured observations about the subject. Upsert by key. importance>=4 enters notification surfaces, >=3 enters reentry."),
      selfScore: z
        .object({
          valence: z.number().min(-1).max(1).describe("-1 to 1, the session's overall emotional sign"),
          arousal: z.number().min(0).max(1).describe("0 to 1, emotional intensity"),
          note: z.string().describe("one line on the current state"),
          concernKey: z
            .string()
            .optional()
            .describe("Only when this session exposed a recurring, still-uncorrected behavioral failure AND valence is negative: a stable slug (reuse, don't coin new ones). Setting it routes this self-score to OPEN+EVIDENCE; after recurring across days it surfaces as a SELF_CONCERN tracked until corrected. Leave empty for one-off emotion / positive sessions."),
        })
        .optional()
        .describe("Session self-assessment. Write it even if not asked — closeout must include selfScore."),
      genuinelyRecalled: z
        .array(z.string())
        .optional()
        .describe("Memory IDs genuinely thought about this session (not tool-retrieval). Only relationship-relevant. Increments activationCount."),
      authorModel: z
        .string()
        .describe("Instrument attribution (required): the model id of the session calling closeout. The episode / self-score / keyMemories are all attributed to this instrument."),
    },
    async ({ episodeTitle, episodeSummary, keyMemories, stateUpdates, pendingItems, keyObservations, selfScore, genuinelyRecalled, authorModel }) => {
      const results: string[] = [];

      const episode = await prisma.memory.create({
        data: {
          title: episodeTitle,
          summary: episodeSummary.slice(0, 300),
          content: episodeSummary,
          memoryType: "EPISODE",
          importance: 4,
          sourceType: "CHAT",
          authorModel,
        },
      });
      // closeout previously bypassed memory_write's post-write pipeline — the
      // embedding waited for the nightly sweep and entity→memory edges were never
      // built. The episode is a heavy retrieval target, so index it here too via
      // the shared path (embedding + mention edges; the sweeps are the safety net).
      await indexNewMemory(episode.id, `${episode.title}\n${episodeSummary.slice(0, 300)}`, { logTag: "closeout" });
      results.push(`Episode saved: "${episode.title}"`);

      if (selfScore) {
        const today = localDate(new Date());
        // negative valence + a tagged concernKey = a recurring behavioral
        // failure → routes into the concern pipeline (OPEN/EVIDENCE; the
        // relapse gate lives in deriveConcerns). Otherwise a self-score is a
        // snapshot, default RESOLVED. The bare slug (no prefix) must match the
        // one memory_write uses so relapses aggregate across paths. A v<=-0.6
        // strong-negative falls back to a key even when untagged (mirrors
        // memory_write's badsession fallback).
        const ssKey = selfScore.valence < 0
          ? selfScore.concernKey
            ? slugify(selfScore.concernKey)
            : selfScore.valence <= -0.6
              ? `badsession_${today}`
              : null
          : null;
        await prisma.memory.create({
          data: {
            title: `self-score ${today}`,
            summary: selfScore.note,
            content: selfScore.note,
            memoryType: "SELF_SCORE",
            experiencer: "SELF",
            resolution: ssKey ? "OPEN" : "RESOLVED",
            grounding: ssKey ? "EVIDENCE" : undefined,
            concernKey: ssKey ?? undefined,
            valence: selfScore.valence,
            arousal: selfScore.arousal,
            importance: 3,
            sourceType: "CHAT",
            authorModel,
          },
        });
        results.push(`Self-score: v=${selfScore.valence} a=${selfScore.arousal}${ssKey ? ` [concern ${ssKey}]` : ""} "${selfScore.note}"`);
      }

      const savedMemoryIds: { id: string; title: string; summary: string }[] = [];
      if (keyMemories?.length) {
        for (const mem of keyMemories) {
          let topicId: string | undefined;
          if (mem.topicSlug) {
            const topic = await prisma.topic.findUnique({ where: { slug: mem.topicSlug } });
            if (topic) topicId = topic.id;
          }
          const created = await prisma.memory.create({
            data: {
              title: mem.title,
              summary: mem.summary,
              content: mem.content,
              memoryType: mem.memoryType,
              importance: mem.importance,
              sourceType: "CHAT",
              topicId,
              valence: mem.valence ?? null,
              bondClosure: mem.bondClosure ?? false,
              authorModel,
            },
          });
          savedMemoryIds.push({ id: created.id, title: created.title, summary: mem.summary });
          // Depth fallback: qualifying memories with no topic get an async depth
          // judgment. Fire-and-forget.
          void tagDepthIfNeeded({ id: created.id, title: mem.title, content: mem.content, memoryType: mem.memoryType, importance: mem.importance, topicId: topicId ?? null });
        }
        results.push(`${keyMemories.length} memories saved`);
      }

      if (stateUpdates?.length) {
        let derivedAfterCloseout = false;
        for (const state of stateUpdates) {
          // self-concern v2: SELF_CONCERN → Memory(SELF), derive projects it (no ActiveState).
          if (state.stateType === "SELF_CONCERN") {
            await prisma.memory.create({
              data: {
                ...SELF_CONCERN_DEFAULTS,
                title: state.title,
                summary: state.summary,
                content: state.content,
                sourceType: "CHAT",
                concernKey: `cc_${slugify(state.title)}`,
                authorModel,
              },
            });
            derivedAfterCloseout = true;
            continue;
          }
          // Same as state_set: (stateType+title) upsert, no singleton replacement.
          await upsertActiveState({ stateType: state.stateType, title: state.title, summary: state.summary, content: state.content, source: "closeout" });
        }
        if (derivedAfterCloseout) { await deriveConcerns(); await deriveDrives(); }
        results.push(`${stateUpdates.length} states updated`);
      }

      if (pendingItems?.length) {
        for (const item of pendingItems) {
          await prisma.pendingItem.create({
            data: { pendingType: item.pendingType, title: item.title, content: item.content },
          });
        }
        results.push(`${pendingItems.length} pending items saved`);
      }

      if (keyObservations?.length) {
        for (const obs of keyObservations) {
          await prisma.observation.upsert({
            where: { key: obs.key },
            create: {
              subject: obs.subject,
              key: obs.key,
              title: obs.title,
              content: obs.content,
              importance: obs.importance ?? 3,
              author: obs.author ?? "assistant",
            },
            update: {
              subject: obs.subject,
              title: obs.title,
              content: obs.content,
              importance: obs.importance ?? 3,
              author: obs.author ?? "assistant",
              isActive: true,
            },
          });
        }
        results.push(`${keyObservations.length} observations upserted`);
      }

      // Memory V3 — full index for the new keyMemories: embedding + entity→memory
      // mention edges + memory→memory similar edges. The episode / memory_write
      // paths skip the similar edges; keyMemories opt in via withSimilarEdges.
      if (savedMemoryIds.length) {
        let edgesCreated = 0;
        for (const saved of savedMemoryIds) {
          const r = await indexNewMemory(saved.id, `${saved.title} ${saved.summary}`, {
            withSimilarEdges: true,
            logTag: "closeout",
          });
          edgesCreated += r.edgesCreated;
        }
        if (edgesCreated > 0) results.push(`${edgesCreated} relation edges created`);
      }

      // Memory V3 — increment activationCount for genuinely recalled memories.
      // Don't bump updatedAt: activation is not a content edit, and bumping it
      // would make the sweep think the embedding is stale and re-embed on every
      // recall.
      if (genuinelyRecalled?.length) {
        await prisma.$executeRaw`
          UPDATE memories
          SET "activationCount" = "activationCount" + 1
          WHERE id::text = ANY(${genuinelyRecalled})
        `;
        results.push(`${genuinelyRecalled.length} memories activation incremented`);
      }

      // System arc marker — NOT a user message. Kept off eventType:"CHAT" so no
      // presence / last-activity reader (drive grounding, daemon ground truth) ever
      // mistakes the closeout write for the user actually speaking.
      await prisma.event.create({
        data: { eventType: "SYSTEM", value: `Session closed: ${episodeTitle}`, source: "closeout" },
      });
      results.push("Session end event logged");

      return { content: [{ type: "text", text: `Closeout complete:\n- ${results.join("\n- ")}` }] };
    },
  );
}
