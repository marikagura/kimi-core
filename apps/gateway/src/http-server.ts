import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAllTools } from "./tools.js";

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
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error("/mcp error:", err?.message || err);
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

function createMcpServer() {
  const server = new McpServer({ name: "kimi", version: "0.1.0" });
  registerAllTools(server);
  return server;
}

const PORT = parseInt(process.env.PORT || "3001");
app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});
