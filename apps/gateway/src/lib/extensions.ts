// Extension mechanism — opt-in modules that add MCP tools on top of the core
// memory engine. The core ships with NONE enabled; a deployment wires only the
// ones it wants. This mirrors the registerAction registry in lib/agency.ts (which
// is the opt-in point for daemon actions): tools plug in here, daemon actions plug
// in via registerAction. Neither is loaded by default.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface KimiExtension {
  /** Stable identifier, used in logs. */
  name: string;
  /** Register this extension's MCP tools on the server. Optional — an extension
   *  may ship only a daemon action (via registerAction) or only a CLI loop. */
  registerTools?: (server: McpServer) => void;
}

/**
 * Wire a set of opt-in extensions onto the MCP server. Call AFTER registerAllTools
 * so extension tools register alongside (not instead of) the core tools. A
 * deployment that wants e.g. the paper extension does:
 *   import { paperExtension } from "./extensions/paper/index.js";
 *   registerAllTools(server);
 *   loadExtensions(server, [paperExtension]);
 */
export function loadExtensions(server: McpServer, extensions: KimiExtension[]): void {
  for (const ext of extensions) {
    ext.registerTools?.(server);
    console.log(`[ext] loaded: ${ext.name}`);
  }
}
