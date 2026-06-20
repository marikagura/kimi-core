// Paper extension — opt-in. Adds paper_search / paper_write tools over the
// paper_notes store. The fetch loop is a separate on-demand CLI (loop.ts,
// `npm run paper:loop`).
//
// To enable in a deployment, after registerAllTools(server):
//   import { paperExtension } from "./extensions/paper/index.js";
//   loadExtensions(server, [paperExtension]);
//
// Core ships with this disabled — wiring it is the deployment's choice.

import type { KimiExtension } from "../../lib/extensions.js";
import { registerPaperTools } from "./tools.js";

export const paperExtension: KimiExtension = {
  name: "paper",
  registerTools: registerPaperTools,
};
