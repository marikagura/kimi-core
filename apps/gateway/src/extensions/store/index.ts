// Store extension — opt-in. Adds a `store` tool (structured CRUD over the
// store_rows table) and a `state_snapshot` tool (a read-only composed snapshot
// for desktop/dashboard surfaces). This is the structured-data half a front-end
// needs, distinct from the agent-text memory tools — front-ends (kimi-room /
// kimi-manor) call it as the one backend.
//
// Enable via KIMI_EXTENSIONS=store (see lib/enabled-extensions.ts), or manually
// after registerAllTools(server):
//   import { storeExtension } from "./extensions/store/index.js";
//   loadExtensions(server, [storeExtension]);
//
// Core ships with this disabled — wiring it is the deployment's choice.

import type { KimiExtension } from "../../lib/extensions.js";
import { registerStoreTools } from "./tools.js";

export const storeExtension: KimiExtension = {
  name: "store",
  registerTools: registerStoreTools,
};
