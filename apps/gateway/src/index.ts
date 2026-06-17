// Stdio MCP server. A local MCP client (e.g. Claude Desktop/Code) talks to this
// via its mcp config. All tool definitions live in tools.ts — this file only
// bootstraps the transport.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./tools.js";

const server = new McpServer({ name: "kimi", version: "0.1.0" });
registerAllTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
