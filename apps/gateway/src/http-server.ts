import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAllTools } from "./tools.js";
import { loadExtensions } from "./lib/extensions.js";
import { enabledExtensions } from "./lib/enabled-extensions.js";
import { errMessage } from "./lib/err.js";
import prisma from "./db.js";
import { EventType } from "@prisma/client";
import { writeChatEvent } from "./lib/chat-write.js";

const app = express();

// CORS: locked down to the origins listed in CORS_ALLOWED_ORIGINS (comma-
// separated). Leave the env var unset to disable cross-origin requests entirely
// (same-origin only). Do NOT ship with `cors()` (fully open) in production.
const corsOrigins = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({ origin: corsOrigins.length > 0 ? corsOrigins : false }));

// API key is required — no default fallback. A missing key is a hard startup
// failure rather than a silent open door: an unauthenticated MCP endpoint would
// expose every tool (read memory / mail / calendar, write state) to anyone who
// can reach the port.
const API_KEY = process.env.KIMI_API_KEY;
if (!API_KEY) {
  console.error("FATAL: KIMI_API_KEY is not set. Refusing to start without an API key.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  // Prisma lazily connects, so without this a missing DB only surfaces deep inside
  // the first tool call (while /health reports ok). Fail at boot instead.
  console.error("FATAL: DATABASE_URL is not set. Point it at your Postgres (docker compose up -d, or your own). See .env.example.");
  process.exit(1);
}

// Global Bearer auth. /health is the only unauthenticated route. There is no
// OAuth discovery/token flow: clients pass a static `Authorization: Bearer
// <KIMI_API_KEY>` header. (An earlier OAuth stub that echoed the API key back to
// any anonymous caller was a full auth bypass and has been removed; if real
// OAuth is ever needed, it must use PKCE + short-TTL one-time codes and issue
// access tokens decoupled from KIMI_API_KEY — never echo the primary key.)
// Precomputed once. Compared in constant time so response latency can't leak
// the key byte-by-byte. The length check is a prerequisite of timingSafeEqual
// (it throws on unequal lengths) and reveals nothing secret — the key length is
// already implied by the scheme.
const EXPECTED_AUTH = Buffer.from(`Bearer ${API_KEY}`);
function authOk(header: string | string[] | undefined): boolean {
  if (typeof header !== "string") return false;
  const got = Buffer.from(header);
  if (got.length !== EXPECTED_AUTH.length) return false;
  return timingSafeEqual(got, EXPECTED_AUTH);
}

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (!authOk(req.headers.authorization)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", name: "kimi" });
});

// ─── Streamable HTTP transport (modern, stateless) — POST /mcp ──────────
// Stateless (sessionIdGenerator undefined): a fresh McpServer + transport per
// request, no in-memory session map — so a server restart can never orphan a
// session. Behind the same global Bearer auth middleware.
app.post("/mcp", express.json(), async (req, res) => {
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: unknown) {
    console.error("/mcp error:", errMessage(err));
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});
// Stateless mode has no server-initiated stream or session teardown.
app.get("/mcp", (_req, res) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method Not Allowed (stateless /mcp; use POST)" }, id: null }));
app.delete("/mcp", (_req, res) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method Not Allowed (stateless /mcp)" }, id: null }));

// ─── Generic ingest — POST /events ──────────────────────────────────────────
// A platform-neutral signal sink: any client (a phone shortcut, a Tasker task, a
// webhook, a cron job, plain curl) POSTs a signal and it lands as one row in the
// events table — the event-sourcing spine. Behind the same global Bearer auth.
// Only the "external signal" event kinds are accepted (not the agent-internal
// ones). See docs/EXTENSIONS.md (§5 Ingest) for how an iOS Shortcut / a calendar / a mailbox map
// onto this as example clients — none required; curl works.
const INGEST_KINDS: EventType[] = [EventType.APP_OPEN, EventType.MANUAL_NOTE, EventType.SYSTEM];
app.post("/events", express.json(), async (req, res) => {
  try {
    const { eventType, value, source } = (req.body ?? {}) as {
      eventType?: string;
      value?: string;
      source?: string;
    };
    const kind =
      typeof eventType === "string" && (INGEST_KINDS as string[]).includes(eventType)
        ? (eventType as EventType)
        : EventType.MANUAL_NOTE;
    const ev = await prisma.event.create({
      data: {
        eventType: kind,
        value: typeof value === "string" ? value.slice(0, 2000) : null,
        source: typeof source === "string" && source.trim() ? source.trim().slice(0, 80) : "ingest",
      },
      select: { id: true, createdAt: true },
    });
    res.json({ ok: true, id: ev.id, eventType: kind, at: ev.createdAt.toISOString() });
  } catch (err: unknown) {
    console.error("/events error:", errMessage(err));
    if (!res.headersSent) res.status(500).json({ error: "ingest failed" });
  }
});

// ─── Conversational ingest — POST /chat ──────────────────────────────────────
// One chat message per call ({ role, text, source? }), stored as a CHAT event the
// merge + digest path reads. Separate from POST /events on purpose: the backend
// assembles a compliant CHAT value ({role,text} JSON) and defaults source to
// CHAT_SOURCE, so loadMergedChat (cross-surface timeline) and the digest tick
// both cover it. (POST /events stores opaque text under source=ingest, which the
// chat readers skip — see docs/EXTENSIONS.md.) A front end posts the user message
// on send and the assistant message once its own generation completes; pass a
// distinct `source` per surface to keep them on separate, mergeable tracks.
// Behind the same global Bearer auth.
app.post("/chat", express.json(), async (req, res) => {
  try {
    const { role, text, threadId, source, dedupeKey } = (req.body ?? {}) as {
      role?: string;
      text?: string;
      threadId?: string;
      source?: string;
      dedupeKey?: string;
    };
    if (typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "text required" });
      return;
    }
    // writeChatEvent validates threadId (throws on a bad charset/length → 400) and
    // dedups on the optional client idempotency key so a retried send is a no-op.
    let result;
    try {
      result = await writeChatEvent({ role, text, threadId, source, dedupeKey });
    } catch (e: unknown) {
      if (e instanceof Error && e.message.startsWith("threadId")) {
        res.status(400).json({ error: e.message });
        return;
      }
      throw e;
    }
    res.json({ ok: true, id: result.id, at: result.at.toISOString(), deduped: result.deduped });
  } catch (err: unknown) {
    console.error("/chat error:", errMessage(err));
    if (!res.headersSent) res.status(500).json({ error: "chat ingest failed" });
  }
});

function createMcpServer() {
  const server = new McpServer({ name: "kimi", version: "0.1.0" });
  registerAllTools(server);
  loadExtensions(server, enabledExtensions());
  return server;
}

const PORT = parseInt(process.env.PORT || "3001");
app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});
