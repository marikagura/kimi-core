// Extension mechanism — opt-in modules that add behavior on top of the core
// memory engine. The core ships with NONE enabled; a deployment turns on only the
// ones it wants, by name, via KIMI_EXTENSIONS (see enabled-extensions.ts).
//
// An extension has two optional seams, applied in two different process contexts:
//   - registerTools(server): MCP-server side — add MCP tools alongside the core
//     tools (called from index.ts / http-server.ts, after registerAllTools).
//   - registerActions():     daemon side — register agency actions (via
//     registerAction from lib/agency.ts) and/or start scheduled jobs (node-cron).
//     Called once at daemon startup (see daemon.ts).
// An extension may implement either, both, or neither. Nothing loads by default.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface KimiExtension {
  /** Stable identifier, used in logs. */
  name: string;
  /** MCP-server seam: register this extension's MCP tools on the server. Optional
   *  — an extension may ship only daemon behavior (registerActions) or a CLI loop. */
  registerTools?: (server: McpServer) => void;
  /** Daemon seam: register agency actions (registerAction) and/or start scheduled
   *  jobs. Called once at daemon startup, in the daemon process. Optional. */
  registerActions?: () => void;
}

/**
 * MCP-server side: wire opt-in extension TOOLS onto the server. Call AFTER
 * registerAllTools so extension tools register alongside (not instead of) the core
 * tools:
 *   registerAllTools(server);
 *   loadExtensions(server, enabledExtensions());
 * Extensions without a registerTools seam (e.g. a daemon-only action) are skipped.
 */
export function loadExtensions(server: McpServer, extensions: KimiExtension[]): void {
  for (const ext of extensions) {
    if (!ext.registerTools) continue;
    ext.registerTools(server);
    console.log(`[ext] tools loaded: ${ext.name}`);
  }
}

/**
 * Daemon side: run opt-in extensions' daemon seam — agency actions and/or
 * scheduled jobs. Call once at daemon startup:
 *   loadExtensionActions(enabledExtensions());
 * Empty env → no extensions → no-op (the core daemon is unchanged). Extensions
 * without a registerActions seam (e.g. a tools-only extension) are skipped.
 */
export function loadExtensionActions(extensions: KimiExtension[]): void {
  for (const ext of extensions) {
    if (!ext.registerActions) continue;
    ext.registerActions();
    console.log(`[ext] daemon actions loaded: ${ext.name}`);
  }
}
