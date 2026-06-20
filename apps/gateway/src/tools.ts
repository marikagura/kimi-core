// ============================================================================
// Shared MCP tool registry.
// Both the stdio server (index.ts) and the SSE server (http-server.ts) register
// the same tools through registerAllTools(server).
//
// If you add, remove, or change a tool, do it here — nowhere else.
//
// Open-source core: this registry exposes the memory engine only — memory,
// topics, state, entities, observations, events, profiles, register presets,
// and the context builders (reentry / reentry_delta / closeout). Surface
// integrations (mail, calendar, location/weather, finance, etc.) are not part
// of the core and are wired separately by a deployment.
// ============================================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMemoryTools } from "./tools-memory.js";
import { registerStateTools } from "./tools-state.js";
import { registerEntityTools } from "./tools-entity.js";
import { registerProfileTools } from "./tools-profile.js";
import { registerReentryTools } from "./tools-reentry.js";
import { registerCloseoutTools } from "./tools-closeout.js";

// Re-export the shared SELF_CONCERN helpers from their new home so existing
// importers (and the integration test) keep importing from "./tools.js".
export { SELF_CONCERN_DEFAULTS, upsertActiveState } from "./tools-shared.js";

// ----------------------------------------------------------------------------
// Tool registration
// ----------------------------------------------------------------------------

export function registerAllTools(server: McpServer) {
  registerMemoryTools(server);
  registerStateTools(server);
  registerEntityTools(server);
  registerProfileTools(server);
  registerReentryTools(server);
  registerCloseoutTools(server);
}
