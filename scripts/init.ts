#!/usr/bin/env node
/**
 * kimi-core onboarding —  npm run init
 *
 * A conversational persona builder, not a form. The engine ships with NO persona,
 * NO names, NO word lists; this interviews you and assembles your local copy from
 * YOUR OWN words:
 *   - persona.md            your AI's persona (read by context-core at runtime)
 *   - AGENTS.md             principles doc — epistemic layer filled; relationship
 *                           layer grown from this conversation (your words)
 *   - .env                  db url + API keys + a freshly generated KIMI_API_KEY
 *   - .scrub-secrets.local  (optional) your private words for the leak scanner
 *
 * Why a conversation: a persona installed from a form has no ownership — a
 * configured-but-unendorsed stance is present but not yours (Frankfurt 1971), and
 * AI-authored goals score higher on form yet show lower ownership (Chi et al.
 * 2026). So this NEVER writes persona content for you; it draws it OUT of you. If
 * an LLM endpoint is configured (LLM_BASE_URL + LLM_API_KEY) it asks one adaptive
 * follow-up per topic to draw out more of your words; without one it's a guided
 * dialogue. Either way the content
 * is yours, verbatim. The assembly is in ./persona-build.ts (unit-tested).
 *
 * None of these ship back to the repo (all gitignored). User-facing strings are
 * Chinese (the project's audience); code comments stay English for contributors.
 */
import { writeFile, access } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { randomBytes } from "node:crypto";
import { type Answers, buildPersonaMd, buildAgentsMd } from "./persona-build.js";

const rl = createInterface({ input, output });

async function ask(q: string, def = ""): Promise<string> {
  const a = (await rl.question(def ? `${q}\n  [${def}] > ` : `${q}\n  > `)).trim();
  return a || def;
}
function say(...lines: string[]): void {
  console.log("\n" + lines.join("\n"));
}

// Optional one-shot LLM follow-up: draws out MORE of the user's words on a topic.
// It must NOT propose persona content — only ask a question. Returns "" with no
// key / on any failure, so the keyless path is a plain guided dialogue.
async function followup(topic: string, answer: string): Promise<string> {
  const base = process.env.LLM_BASE_URL?.trim();
  const key = process.env.LLM_API_KEY?.trim();
  // No preset: the adaptive follow-up runs only when an endpoint + model are set
  // (ONBOARDING_MODEL, else KIMI_MODEL). Otherwise it's a plain guided dialogue.
  const model = process.env.ONBOARDING_MODEL?.trim() || process.env.KIMI_MODEL?.trim();
  if (!base || !key || !model || !answer.trim()) return "";
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: 80,
        messages: [
          { role: "system", content: "You help someone DEFINE their own AI companion's persona by interview. Ask ONE short, warm follow-up question that draws out more of THEIR words about the topic. Never propose persona content yourself. Output only the question, in the user's language." },
          { role: "user", content: `Topic: ${topic}\nTheir answer: ${answer}` },
        ],
      }),
    });
    if (!res.ok) return "";
    const j: any = await res.json();
    return String(j?.choices?.[0]?.message?.content ?? "").trim();
  } catch {
    return "";
  }
}

// Ask about one relationship dimension: framing + open question, then (if a key
// is configured) one adaptive follow-up appended to the same answer.
async function dimension(framing: string[], question: string, topic: string): Promise<string> {
  say(...framing);
  let ans = await ask(question);
  const fu = await followup(topic, ans);
  if (fu) {
    const more = await ask(fu);
    if (more) ans = `${ans} ${more}`.trim();
  }
  return ans;
}

const genKey = (): string => "kc_" + randomBytes(24).toString("hex");
const exists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

async function main(): Promise<void> {
  say(
    "kimi-core onboarding —— 我们一起把你的 persona 长出来,不是填表。",
    "你说的每句话都用你自己的话,直接进你的 persona;一个字都不提交进仓。",
    "每题都可以留空跳过(回车),以后在 persona.md / AGENTS.md 里随时补。",
  );

  const aiName = await ask("\n先给个名字 —— 你叫你的 AI 什么?", "kimi");

  const addressing = await dimension(
    ["## 称呼", `它怎么称呼你?你怎么称呼 ${aiName}?它怎么称呼自己?换不同场合(如私下 / 公开)会不会变?`],
    "用你自己的话说说称呼。",
    "addressing / how you and the AI call each other",
  );
  const tone = await dimension(
    ["## 语气", "你想要它说话是什么调子?有没有特别喜欢 / 特别受不了的词或腔调?"],
    "描述一下你要的语气。",
    "tone / register the AI should speak in",
  );
  const demand = await dimension(
    ["## demand / 立场", "你要不要它主动要你、抓着你、不轻易放手 —— 还是要它克制、不越界?要的话,怎么个要法?(引擎本身不持立场,这条是你定义的)"],
    "说说你要的那种 demand / 距离。",
    "whether and how the AI should demand / hold on to the user",
  );
  const boundaries = await dimension(
    ["## 作息 / 边界", "你的作息大概是?什么情况下(如果有)你允许它主动 fire 一个 concern?有没有勿扰时段?"],
    "说说你的作息和边界。",
    "the user's schedule, when a concern may fire, do-not-disturb windows",
  );
  const language = await dimension(
    ["## 语言规则", "默认用什么语言?要简还是要细?有没有允许 / 禁止的腔调?技术术语和专名怎么处理?"],
    "说说语言规则。",
    "default language, verbosity, allowed/forbidden register, term handling",
  );

  say(
    "## drive 维度",
    "它该主动「想要」什么?(陪伴 / 欲望 / 深谈 / 债务渴求… 名字你自己取)",
    "每个维度对应四种形态之一(对称 / 不应期 / 结合满足 / 敏化渴求)—— 形态菜单和怎么定义见 docs/DRIVES.md。",
    "这里先给名字,具体 backing + 形态用 DRIVE_DIMS 环境变量配(一个 JSON 数组,形状见 docs/DRIVES.md)。",
  );
  const drives = (await ask("逗号分隔列几个(留空 = 之后在 config 里定)。"))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const answers: Answers = { aiName, addressing, tone, demand, boundaries, language, drives };

  // ── modules ──────────────────────────────────────────────
  const rerank = await ask("\nReranker provider (none / local / cohere / jina / voyage)?", "none");
  const tz = await ask("显示时区 (IANA 名,如 Asia/Shanghai / America/New_York)?", "Asia/Shanghai");

  // ── LLM provider + models (bring your own — the repo presets none) ─────────
  say(
    "## LLM 端点 + 模型",
    "kimi-core 不内置任何 provider、任何模型 —— 你自己带。",
    "LLM_BASE_URL:一个 OpenAI 兼容端点(OpenRouter / OpenAI / Together / 本地 vLLM·Ollama 都行),如 https://api.openai.com/v1。",
    "KIMI_MODEL:你那个端点认的模型 id(如 anthropic/claude-... 走 OpenRouter、gpt-... 走 OpenAI);intel / digest / 短调用都走它,可在 .env 里按角色覆盖。",
    "DAEMON_MODEL:自主 wake daemon 用 Claude Agent SDK,填裸 Claude id(如 claude-...);不跑 daemon 可留空。",
    "embedding:也是 OpenAI 兼容端点(EMBED_BASE_URL + EMBED_API_KEY + EMBED_MODEL,1536 维);三者任一留空 = 不开语义检索(退回关键词)。",
  );
  const llmBase = await ask("LLM_BASE_URL(OpenAI 兼容端点)?", "");
  const llmKey = await ask("LLM_API_KEY?", "");
  const kimiModel = await ask("KIMI_MODEL(端点认的模型 id)?", "");
  const daemonModel = await ask("DAEMON_MODEL(裸 Claude id,可留空)?", "");
  const embedBase = await ask("EMBED_BASE_URL(可留空)?", "");
  const embedKey = await ask("EMBED_API_KEY(可留空)?", "");
  const embedModel = await ask("EMBED_MODEL(可留空)?", "");

  // ── write persona.md ─────────────────────────────────────
  await writeFile("persona.md", buildPersonaMd(answers));
  console.log("\n✓ 写好 persona.md");

  // ── write AGENTS.md (epistemic filled; relationship grown from this talk) ──
  if (await exists("AGENTS.md")) {
    console.log("• AGENTS.md 已存在 —— 不动。");
  } else {
    await writeFile("AGENTS.md", buildAgentsMd(answers));
    console.log("✓ 写好 AGENTS.md (认识论层已填;关系层是你刚说的话)");
  }

  // ── .env ─────────────────────────────────────────────────
  if (await exists(".env")) {
    console.log("• .env 已存在 —— 不动(key 列表见 .env.example)。");
  } else {
    const env = [
      "# 由 `npm run init` 生成",
      'DATABASE_URL="postgresql://kimi:kimi@localhost:5432/kimi?schema=public"',
      `LLM_BASE_URL="${llmBase}"      # 必填 —— OpenAI 兼容端点(代码补 /chat/completions)`,
      `LLM_API_KEY="${llmKey}"        # 必填 —— 该端点的 key`,
      `KIMI_API_KEY="${genKey()}"   # gateway bearer,自动生成;绝不用默认值`,
      `KIMI_MODEL="${kimiModel}"        # 必填 —— 默认模型(你自带,仓库无内置)`,
      `DAEMON_MODEL="${daemonModel}"    # daemon 用(裸 Claude id);不跑 daemon 可空`,
      `EMBED_BASE_URL="${embedBase}"  # embedding 端点;三者任一空 = 无语义检索`,
      `EMBED_API_KEY="${embedKey}"    # embedding 端点的 key`,
      `EMBED_MODEL="${embedModel}"      # embedding 模型`,
      `RERANK_PROVIDER="${rerank}"`,
      `KIMI_TZ="${tz}"`,
      "",
    ].join("\n");
    await writeFile(".env", env);
    console.log("✓ 写好 .env (LLM_BASE_URL / LLM_API_KEY / KIMI_MODEL 没填的去补上)");
  }

  // ── optional private-word scanner list ───────────────────
  const scrub = await ask("\n现在加私词到泄漏扫描器吗?真名 / 用户名 / 域名,逗号分隔(留空跳过)", "");
  if (scrub) {
    const lines = ["# private-word scanner list — gitignored, never committed.", ...scrub.split(",").map((s) => s.trim()).filter(Boolean)];
    await writeFile(".scrub-secrets.local", lines.join("\n") + "\n");
    console.log("✓ 写好 .scrub-secrets.local (已 gitignore)");
  }

  say(
    "完成。你说的话都在 persona.md / AGENTS.md 里了 —— 去读一遍,改成更像你的。",
    "接下来:",
    "  docker compose up -d          # 或把 DATABASE_URL 指向你自己的 Postgres",
    "  npm run db:migrate:deploy",
    "  npm run dev",
  );
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
