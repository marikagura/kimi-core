// ============================================================================
// Profile / observation / register domain tool registry.
// profile_read / private_read / profile_set / observation_write /
// register_set / register_read
// ============================================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import prisma from "./db.js";

export function registerProfileTools(server: McpServer) {
  server.tool("profile_read", "Read all core profile entries (private_* keys are excluded — use private_read for those)", {}, async () => {
    const entries = await prisma.coreProfile.findMany({
      where: { isActive: true, NOT: { key: { startsWith: "private_" } } },
      orderBy: { importance: "desc" },
    });
    const text = entries.length
      ? entries.map((e) => `[${e.key}] ${e.title} (importance: ${e.importance})\n${e.content}`).join("\n\n---\n\n")
      : "No profile entries.";
    return { content: [{ type: "text", text }] };
  });

  server.tool(
    "private_read",
    "Read private_* profile entries — the restricted profile tier.",
    {},
    async () => {
      const entries = await prisma.coreProfile.findMany({
        where: { isActive: true, key: { startsWith: "private_" } },
        orderBy: { importance: "desc" },
      });
      const text = entries.length
        ? entries.map((e) => `[${e.key}] ${e.title} (importance: ${e.importance})\n${e.content}`).join("\n\n---\n\n")
        : "No private entries.";
      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "profile_set",
    "Set or update a core profile entry",
    {
      key: z.string().describe("Profile key"),
      title: z.string(),
      content: z.string(),
      importance: z.number().min(1).max(5).default(3),
      source: z.string().optional(),
    },
    async ({ key, title, content, importance, source }) => {
      const entry = await prisma.coreProfile.upsert({
        where: { key },
        update: { title, content, importance, source },
        create: { key, title, content, importance, source },
      });
      return { content: [{ type: "text", text: `Profile set: [${entry.key}] ${entry.title}` }] };
    },
  );

  server.tool(
    "observation_write",
    [
      "Upsert one structured observation about the user or the assistant. Same shape as closeout's keyObservations slot, but standalone — call mid-conversation when a long-term character signal lands. Avoids firing a full closeout just to record one observation.",
      "",
      "Use this for a cross-session accumulating character pattern — NOT one-off facts:",
      "- user_X: the user's personality / behavior pattern / preference observation",
      "- self_X: the assistant's own register / mechanism / catch",
      "",
      "key is a snake_case unique index — writing the same key updates in place, no duplicate. importance>=4 enters notification surfaces, >=3 enters reentry.",
      "",
      "One-off facts / concrete facts / momentary mood → memory_write, not observation_write.",
    ].join("\n"),
    {
      subject: z.enum(["user", "self"]).describe("Observation subject — the user or the assistant"),
      key: z
        .string()
        .describe("Unique key (snake_case). Same key is an upsert."),
      title: z.string(),
      content: z.string(),
      importance: z.number().min(1).max(5).default(3),
      author: z.string().optional().describe("Who recorded the observation. Default 'assistant'"),
    },
    async ({ subject, key, title, content, importance, author }) => {
      const r = await prisma.observation.upsert({
        where: { key },
        create: { subject, key, title, content, importance, author: author ?? "assistant" },
        update: { subject, title, content, importance, author: author ?? "assistant", isActive: true },
      });
      return {
        content: [
          {
            type: "text",
            text: `Observation upserted: [${r.subject}] ${r.title} (key=${r.key}, importance=${r.importance})`,
          },
        ],
      };
    },
  );

  server.tool(
    "register_set",
    "Create or update a register profile (speaking-style preset)",
    {
      name: z.string().describe("Register name, e.g. default / work / love / gentle / serious"),
      mode: z.enum(["WORK", "LOVE", "MIXED"]).default("MIXED"),
      toneKeywords: z.string().optional().describe("Tone keywords"),
      preferredAddressing: z.string().optional(),
      forbiddenPhrases: z.string().optional(),
      preferredPhrases: z.string().optional(),
      verbosityStyle: z.enum(["SHORT", "MEDIUM", "LONG"]).default("MEDIUM"),
      initiativeStyle: z.enum(["PASSIVE", "LOW", "ACTIVE"]).default("LOW"),
      comfortStyle: z.enum(["EXPLAIN", "COMPANION", "NO_EMPTY_COMFORT"]).default("EXPLAIN"),
      exampleSnippets: z.string().optional(),
      priority: z.number().default(0),
    },
    async (data) => {
      const entry = await prisma.registerProfile.upsert({
        where: { name: data.name },
        update: data,
        create: data,
      });
      return { content: [{ type: "text", text: `Register: [${entry.name}] mode=${entry.mode}` }] };
    },
  );

  server.tool("register_read", "Read all register profiles", {}, async () => {
    const profiles = await prisma.registerProfile.findMany({
      where: { isActive: true },
      orderBy: { priority: "desc" },
    });
    if (!profiles.length) return { content: [{ type: "text", text: "No register profiles." }] };
    const text = profiles
      .map(
        (p) =>
          `[${p.name}] mode=${p.mode}, verbosity=${p.verbosityStyle}, initiative=${p.initiativeStyle}\n  tone: ${p.toneKeywords || "-"}\n  addressing: ${p.preferredAddressing || "-"}`,
      )
      .join("\n\n");
    return { content: [{ type: "text", text }] };
  });
}
