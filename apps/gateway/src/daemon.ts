import "dotenv/config";
import { query } from "@anthropic-ai/claude-agent-sdk";
import cron from "node-cron";
import prisma from "./db.js";
import { localDateTime, localDate, localWeekday, DEFAULT_TZ } from "./time.js";
import { buildPersona } from "@kimi/context-core";
import { ensureSubscriptionAuth, buildGroundTruth } from "./lib/daemon-core.js";
import { dispatchAction, ActionType, type AutonomyMode } from "./lib/agency.js";
import { getNotifier, getSearchProvider } from "./lib/providers.js";
import { modelFor } from "./lib/models.js";
import { firstJsonObject } from "./lib/json-extract.js";

// ============================================================================
// wake daemon — a timer-driven, read-only agent loop.
//
// On each cron pulse the daemon spins up a fresh, stateless Claude Agent SDK
// query() with a read-only tool allowlist, hands it a pre-computed ground-truth
// snapshot of "what the user is doing now", and parses back a single JSON
// decision. The decided action is dispatched through the agency layer, where
// DO_NOTHING is one available outcome among the actions — offered, not preferred
// (acting is the normal case; see literature block below).
//
// ── Wake / heartbeat literature (provenance of this design) ─────────────────
//
// DO_NOTHING (abstention -> agency):
//   - Chow (1970) — reject option (optimum recognition error/reject tradeoff)
//   - Wen et al. (2024/2025) "Know Your Limits" — abstention as a meta-capability
//   - Kirichenko et al. (2025) AbstentionBench — reasoning-tuning costs ~ -24%
//   - Bonagiri et al. (2025) "Selectively Quitting" — the compulsion to act
//   - Sun et al. (2026) When2Tool — knowing != doing (AUROC 0.89-0.96)
//   - Yeke et al. (2026) Yes-Man — robots refuse only ~16.5%
//   claim: lifts "doing nothing" from a reliability knob to a CONSTITUTIVE marker
//   of agency; distinguishes reactive restraint (not acting when triggered) from
//   generative initiation (acting untriggered) — the latter remains an open gap.
//
// self-drive (wanting):
//   - Panksepp (1998) Affective Neuroscience — primary affective systems (SEEKING etc.)
//   - Berridge & Robinson (2003) — wanting != liking (incentive salience)
//   - Davis & Montag (2019) — affective neuroscience personality scales
//   - Colas et al. (2022) — autotelic agents (JAIR 74)
//   honest fault line: ignition vs direction — self-drive shapes "where to go
//   after waking", not "why to wake" (the cron supplies ignition).
//
// wake / heartbeat:
//   - MemGPT (2023) — request_heartbeat (the direct technical ancestor)
//   - ReAct (2022) — agent loop = while-loop + tools
//   nailed: a heartbeat is a timer pulse, not a self-originated impulse.
//
// proactivity / honest positioning:
//   - Wooldridge & Jennings (1995) — weak agency four properties; pro-activeness
//     = "taking the initiative"
//   - Luck & d'Inverno (1995) — agent -> autonomous agent: the boundary is motivation
//   - Lu et al. (2024) ProactiveBench — F1 ~66.47%
//   - Liu et al. (2025) Inner Thoughts (CHI) — nearest neighbor in the literature
//   closing: this layer APPROACHES motivational autonomy, it does not arrive.
//
// curiosity (websearch action):
//   - Schmidhuber (2010) — formal theory of creativity/curiosity
//   - Colas et al. (2022) autotelic; Forestier et al. (2022) IMGEP
//   caveat: an AI curiosity-reward is an information-theoretic scalar; it is not
//   yet Berridge "wanting".
//
// companion dark side (why output follows affect, not retention):
//   - De Freitas et al. (2025) — farewell-guilt as a retention dark pattern
//     (~14x engagement); this layer surfaces by affect, NOT by engagement.
//
// ── Operational notes ───────────────────────────────────────────────────────
//   auth:  ensureSubscriptionAuth() deletes API-key env vars at runtime so the
//          SDK uses CLAUDE_CODE_OAUTH_TOKEN (subscription) rather than metered API.
//   run:   pm2 / your process manager runs this long-lived; cron drives the wakes.
//   test:  WAKE_NOW=1 npx tsx src/daemon.ts   (run one wake immediately)
//   trace: event table, source=daemon_*   /   process-manager logs
// ============================================================================

// Autonomy mode: "propose" (default) keeps a human in the loop — outward-facing
// effects are staged, not committed. Set to "auto" to commit directly.
const AUTONOMY_MODE: AutonomyMode =
  (process.env.DAEMON_AUTONOMY_MODE as AutonomyMode) === "auto" ? "auto" : "propose";

// Read-only tool allowlist — the agent may only call these MCP retrieval tools
// (plus an append-only event_log). Everything else is denied two ways:
//   permissionMode "dontAsk" (deny + no prompt for anything not pre-approved)
//   + canUseTool (programmatic backstop against known allowlist-bypass bugs).
const DAEMON_TOOLS = [
  "mcp__kimi__reentry", // identity + recent state summary on wake
  "mcp__kimi__register_read", // current register (tone / disabled / preferred terms)
  "mcp__kimi__state_read", // self-drive dimensions + open concerns
  "mcp__kimi__memory_search", // recent low-importance episodes / last diary
  "mcp__kimi__memory_read", // read one memory by id (full content)
  "mcp__kimi__event_read", // recent signals / last wake
  "mcp__kimi__graph_walk", // relationship-graph traversal
  "mcp__kimi__entity_search", // look up a person/entity's context
  "mcp__kimi__calendar_list", // schedule grounding
  "mcp__kimi__event_log", // the ONLY permitted write: append-only event log
];
const DAEMON_TOOL_SET = new Set(DAEMON_TOOLS);

// ── optional pluggable notifier ─────────────────────────────────────────────
// A wake can optionally emit an outward notification. This is a generic,
// opt-in hook — the default is a no-op stub. A deployment that wants push
// notifications implements Notifier and passes it to setNotifier(). No framing
// about *whether* to notify lives here; that is the agent's decision plus the
// AUTONOMY_MODE gate.
export interface Notification {
  content: string;
  slug: string;
  priority?: "normal" | "high";
}
export interface Notifier {
  send(n: Notification): Promise<void>;
}
const noopNotifier: Notifier = {
  async send(n: Notification) {
    console.log(`[daemon] notifier(noop) ${n.slug}: ${n.content.slice(0, 60)}`);
  },
};
let notifier: Notifier = noopNotifier;
export function setNotifier(n: Notifier): void {
  notifier = n;
}

// Persona is external: buildPersona() from @kimi/context-core returns the empty
// default unless a persona document is configured. No persona prose ships here.
function loadDaemonPersona(): string {
  return buildPersona({ surface: "tg", registersText: "" });
}

// JSON marker -> event table (source=daemon_*) for observability.
async function marker(source: string, value: Record<string, unknown>) {
  try {
    await prisma.event.create({
      data: { eventType: "SYSTEM", source, value: JSON.stringify(value) },
    });
  } catch (err: any) {
    console.error(`[daemon] marker(${source}) failed:`, err?.message || err);
  }
}

// user prompt — current time + ground-truth snapshot + self-fetch hints + JSON.
function buildWakePrompt(now: Date, ground: string): string {
  const nowLabel = localDateTime(now).slice(0, 16);
  const wd = localWeekday(now);
  const hh = localDateTime(now).slice(11, 13);
  const dateStr = localDate(now);
  return `## Now
${nowLabel} (${wd}).

${ground}

## Fill in the rest yourself
The ground-truth block above already tells you what the user is doing. Use the
read-only tools to fetch what you need: reentry (who you are, recent state),
register_read (current register), state_read (self-drive dimensions + open
concerns — the highest dimension is your direction this tick), and memory_search
for recent episodes / your last diary. Stop once you have enough.
If an emotion label does not match the data, do not paste it — record what you
actually observe via event_log and write what you actually feel.

## What to write is up to you
The diary is written for the next instance of you to read — length is yours,
do not pad to a word count or force a template.

## Optional notification
You MAY emit one outward notification this tick (the "push" field), or none.
This is optional and the decision is yours; the ground-truth block only changes
*what* you would say, not whether to send. If you have nothing worth saying,
set push to null with a one-line reason.

## Wrap the output in this JSON (it is only a container; do not let the fields
## constrain your thinking)
{
  "monologue": "a few honest lines",
  "action": "DIARY" | "NOTE" | "WEBSEARCH" | "EXPLORE" | "DO_NOTHING",
  "action_content": "diary / note body (when applicable)",
  "push": { "content": "one line", "slug": "wake-${hh}-${dateStr}" } | null,
  "no_push_reason": "why push is null (only when null), else null",
  "valence": -1 to 1,
  "arousal": 0 to 1,
  "concern_topic": "stable slug for a cross-day SELF concern (lowercase_underscore, reuse existing), else null",
  "heartbeat": null
}`;
}

// Two-stage parse: try a full JSON object first; on truncation / nested quotes,
// fall back to per-field regex extraction.
function parseWakeJson(response: string): any {
  const cleaned = response
    .replace(/^[\s\S]*?```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const textToParse = cleaned.startsWith("{") ? cleaned : response;
  const obj = firstJsonObject(textToParse);
  if (obj) return obj;
  /* fall through to the field-by-field regex below */
  const mon = textToParse.match(/"monologue"\s*:\s*"([\s\S]*?)"\s*,\s*"action"/);
  const act = textToParse.match(/"action"\s*:\s*"([A-Za-z_]+)"/);
  const actC = textToParse.match(/"action_content"\s*:\s*"([\s\S]*?)"\s*,\s*"push"/);
  const push = textToParse.match(/"push"\s*:\s*\{[^}]*"content"\s*:\s*"([\s\S]*?)"\s*,\s*"slug"\s*:\s*"([^"]+)"/);
  const val = textToParse.match(/"valence"\s*:\s*(-?[\d.]+|null)/);
  const ar = textToParse.match(/"arousal"\s*:\s*([\d.]+|null)/);
  const con = textToParse.match(/"concern_topic"\s*:\s*(?:"([^"]*?)"|null)/);
  const noPush = textToParse.match(/"no_push_reason"\s*:\s*(?:"([^"]*?)"|null)/);
  const unesc = (s: string) => s.replace(/\\n/g, "\n").replace(/\\"/g, '"');
  return {
    monologue: mon ? unesc(mon[1]) : textToParse.slice(0, 500),
    action: (act?.[1] as string) || ActionType.DO_NOTHING,
    action_content: actC ? unesc(actC[1]) : undefined,
    push: push ? { content: unesc(push[1]), slug: push[2] } : null,
    no_push_reason: noPush && noPush[1] ? noPush[1] : null,
    valence: val && val[1] !== "null" ? parseFloat(val[1]) : null,
    arousal: ar && ar[1] !== "null" ? parseFloat(ar[1]) : null,
    concern_topic: con && con[1] ? con[1] : null,
  };
}

async function wake(force = false) {
  ensureSubscriptionAuth();
  const now = new Date();
  const ts = localDateTime(now).slice(0, 16);

  // 30-minute cooldown — guard against crash-restart loops burning tokens.
  // Manual runs (force=true) skip it.
  const lastWake = await prisma.event.findFirst({
    where: { eventType: "SYSTEM", source: "daemon_wake" },
    orderBy: { createdAt: "desc" },
  });
  const hoursSince = lastWake ? (Date.now() - lastWake.createdAt.getTime()) / 3600_000 : 999;
  if (!force && hoursSince < 0.5) {
    console.log(`[${ts}] skip: cooldown ${(hoursSince * 60).toFixed(0)}m`);
    await marker("daemon_skip", { ts: localDateTime(now), reason: "cooldown", hoursSinceLast: +hoursSince.toFixed(2) });
    return;
  }

  await marker("daemon_wake", {
    ts: localDateTime(now),
    reason: "cron",
    hoursSinceLast: lastWake ? +hoursSince.toFixed(2) : null,
  });
  console.log(`[${ts}] daemon wake`);

  try {
    const mcpToken = process.env.KIMI_MCP_TOKEN ?? process.env.KIMI_API_KEY ?? "";
    const options: any = {
      // No built-in model — set DAEMON_MODEL to your own Claude model id (a BARE id
      // like "claude-...", not an OpenRouter slug; the Claude Agent SDK resolves it
      // against your subscription). Unset → a clear error, never a silent default.
      model: modelFor("DAEMON_MODEL"),
      systemPrompt: loadDaemonPersona() || "",
      // Streamable-HTTP MCP — MUST match what the gateway exposes (http-server.ts
      // serves POST /mcp). type "http" = the modern Streamable HTTP transport.
      mcpServers: {
        kimi: {
          type: "http",
          url: process.env.KIMI_MCP_URL ?? "http://127.0.0.1:3001/mcp",
          headers: { Authorization: `Bearer ${mcpToken}` },
        },
      },
      allowedTools: DAEMON_TOOLS, // pre-approve these (skip the permission prompt)
      permissionMode: "dontAsk", // anything not pre-approved is denied, no prompt
      // Programmatic backstop against known allowlist-bypass bugs: deny any tool
      // outside the read-only allowlist.
      canUseTool: async (toolName: string) => {
        if (DAEMON_TOOL_SET.has(toolName)) return { behavior: "allow" as const };
        console.warn(`[daemon] denied non-allowlisted tool: ${toolName}`);
        return { behavior: "deny" as const, message: `${toolName} is not in the read-only allowlist` };
      },
      // No resume — each tick is a fresh reentry (stateless: no carried-over
      // emotion across ticks, no spiral, no damping needed).
    };

    let result = "";
    const toolsCalled: string[] = []; // every tool_use the agent attempted (incl. denied)
    const ground = await buildGroundTruth(now); // ground truth into the prompt head
    for await (const m of query({ prompt: buildWakePrompt(now, ground), options }) as any) {
      if (m.type === "assistant" && Array.isArray(m.message?.content)) {
        for (const b of m.message.content) {
          if (b?.type === "tool_use" && typeof b.name === "string") {
            toolsCalled.push(b.name.replace(/^mcp__kimi__/, ""));
          }
        }
      }
      if (m.type === "result") result = m.subtype === "success" ? m.result : "";
    }
    // dontAsk guarantees allowlisted tools executed and the rest were denied.
    // Group accordingly so denied attempts are not displayed as "called".
    const WL_SHORT = new Set([...DAEMON_TOOL_SET].map((t) => t.replace(/^mcp__kimi__/, "")));
    const executed = [...new Set(toolsCalled.filter((t) => WL_SHORT.has(t)))];
    const blocked = [...new Set(toolsCalled.filter((t) => !WL_SHORT.has(t)))];
    console.log(`[${ts}] executed (allowlist): ${executed.join(", ") || "(none — no retrieval; possibly hallucinating)"}`);
    if (blocked.length) console.log(`[${ts}] blocked (denied by dontAsk, not executed): ${blocked.join(", ")}`);
    if (!result) {
      console.error(`[${ts}] empty result`);
      await marker("daemon_error", { ts: localDateTime(now), error: "empty result from query()" });
      return;
    }

    const parsed = parseWakeJson(result);

    // monologue marker — always (observability of the decision + retrieval behavior).
    await marker("daemon_monologue", {
      ts: localDateTime(now),
      monologue: parsed.monologue ?? null,
      action: parsed.action ?? null,
      valence: typeof parsed.valence === "number" ? parsed.valence : null,
      arousal: typeof parsed.arousal === "number" ? parsed.arousal : null,
      concern_topic: parsed.concern_topic ?? null,
      toolsExecuted: executed,
      toolsBlocked: blocked,
      retrievedReentry: executed.includes("reentry"), // false = wrote without reentry, a red flag
    });

    // action dispatch — route through the agency layer (DO_NOTHING is one option, offered not preferred).
    // search provider is injected so WEBSEARCH can actually act when configured (default no-op).
    const actionResult = await dispatchAction(parsed.action, { parsed, now, search: getSearchProvider() }, AUTONOMY_MODE);
    await marker("daemon_action", {
      ts: localDateTime(now),
      type: actionResult.type,
      performed: actionResult.performed,
      outcome: actionResult.outcome,
      detail: actionResult.detail ?? null,
    });

    // optional notification (pluggable; default no-op). Honors AUTONOMY_MODE:
    // in "propose" mode the notification is recorded but not sent outward.
    if (parsed.push?.content && typeof parsed.push?.slug === "string" && parsed.push.slug.trim()) {
      const slug = parsed.push.slug.trim().toLowerCase();
      if (AUTONOMY_MODE === "auto") {
        await notifier.send({ content: parsed.push.content, slug, priority: "high" });
        await marker("daemon_notify", { ts: localDateTime(now), slug, sent: true });
      } else {
        await marker("daemon_notify_proposed", { ts: localDateTime(now), slug, content: parsed.push.content, sent: false });
        console.log(`[${ts}] notify PROPOSED (not sent — propose mode) ${slug}: ${parsed.push.content.slice(0, 60)}`);
      }
    } else {
      await marker("daemon_no_push", {
        ts: localDateTime(now),
        reason: parsed.no_push_reason ?? null,
        flag: parsed.no_push_reason ? "intentional" : "no_reason_given",
      });
      console.log(`[${ts}] no notification — ${parsed.no_push_reason ?? "(no reason given)"}`);
    }

    console.log(`[${ts}] action=${parsed.action} mono="${(parsed.monologue || "").slice(0, 40)}"`);
  } catch (err: any) {
    console.error(`[${ts}] wake error:`, err?.message || err);
    await marker("daemon_error", { ts: localDateTime(now), error: String(err?.message || err) });
  }
}

// ===== scheduler (long-lived; does not burn LLM tokens) =====
ensureSubscriptionAuth(); // fail fast at startup if the token is missing
if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is not set. See .env.example.");
  process.exit(1);
}
modelFor("DAEMON_MODEL"); // fail fast at startup: a missing wake model would otherwise only error per-wake, inside a swallowed catch, while "wake daemon up" still prints
setNotifier(getNotifier()); // install the configured notifier (default: console/no-op)
// Cron schedule is config-driven (default: 09:00 and 21:00 daily, in KIMI_CRON_TZ).
const WAKE_CRON = process.env.DAEMON_WAKE_CRON || "0 9,21 * * *";
const WAKE_TZ = process.env.KIMI_CRON_TZ || DEFAULT_TZ;
cron.schedule(WAKE_CRON, () => {
  wake().catch((e) => console.error("[daemon] cron error:", e?.message || e));
}, { timezone: WAKE_TZ });
console.log(`[daemon] wake daemon up — cron "${WAKE_CRON}" (${WAKE_TZ}), autonomy=${AUTONOMY_MODE}`);

// Manual trigger (for verification, skips cooldown): WAKE_NOW=1 npx tsx src/daemon.ts
if (process.env.WAKE_NOW === "1") {
  wake(true)
    .then(() => { console.log("[daemon] manual wake done"); process.exit(0); })
    .catch((e) => { console.error("[daemon] manual wake error:", e?.message || e); process.exit(1); });
}
