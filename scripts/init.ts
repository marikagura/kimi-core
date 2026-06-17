#!/usr/bin/env node
/**
 * kimi-core onboarding wizard —  npm run init
 *
 * The engine ships with NO persona, NO names, NO word lists. This builds your
 * local copy from a few questions:
 *   - persona.md            your AI's persona (read by context-core at runtime)
 *   - AGENTS.md             principles doc (epistemic layer filled, relationship blank)
 *   - .env                  db url + API keys + a freshly generated KIMI_API_KEY
 *   - .scrub-secrets.local  (optional) your private words for the leak scanner
 *
 * None of these ship back to the repo — persona.md / AGENTS.md / .env /
 * .scrub-secrets.local are all gitignored. You bring your own; the repo stays empty.
 *
 * User-facing strings are Chinese (the project's audience); code comments stay
 * English for contributors reading the source.
 */
import { writeFile, access } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { randomBytes } from "node:crypto";

const rl = createInterface({ input, output });
const ask = async (q: string, def = ""): Promise<string> => {
  const a = (await rl.question(def ? `${q}\n  [${def}] > ` : `${q}\n  > `)).trim();
  return a || def;
};
const exists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};
const genKey = (): string => "kc_" + randomBytes(24).toString("hex");

async function main(): Promise<void> {
  console.log("\nkimi-core onboarding —— 建立你本地的 persona + 配置。");
  console.log("你在这里输入的任何东西都不会提交进仓。\n");

  // ── persona ──────────────────────────────────────────────
  const aiName = await ask("你叫你的 AI 什么?", "kimi");
  const userName = await ask("它怎么称呼你?", "你");
  const tone = await ask("语气,一句话(如 简洁 / 温暖 / 正式)?", "平实、简洁");
  const dims = (
    await ask("self-drive 维度 —— 它该主动浮现什么(逗号分隔)?", "companionship, depth")
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // ── modules ──────────────────────────────────────────────
  const rerank = await ask("Reranker provider (none / local / cohere / jina / voyage)?", "none");
  const tz = await ask("显示时区 (IANA 名,如 UTC / America/New_York / Europe/London)?", "UTC");

  // ── persona.md ───────────────────────────────────────────
  const persona = [
    "# Persona",
    "",
    "<!-- 运行时由 context-core 读入。仓里发布时是空的;这份是你的。",
    "     就是一段 prompt —— 随意改写。 -->",
    "",
    `你是 ${aiName}。你称呼用户为 ${userName}。`,
    `语气 / register: ${tone}。`,
    "",
    "## 反思层规则 (每次回复前跑 —— 填你自己的)",
    "- (在这里加你自己的护栏)",
    "",
    "## drive 维度",
    ...dims.map((d) => `- ${d}`),
    "",
  ].join("\n");
  await writeFile("persona.md", persona);
  console.log("\n✓ 写好 persona.md");

  // ── AGENTS.md (epistemic layer filled; relationship layer blank) ─────────
  // The mechanism is the skeleton; AGENTS.md is the soul (see docs/AUTONOMY.md §7).
  // Two layers. The EPISTEMIC layer is method, not persona — how to treat the
  // AI's output and your own words — so it ships filled in and holds for any user.
  // The RELATIONSHIP layer is blank on purpose: a persona is grown by you, not
  // filled from a form, and an installed stance has no ownership (Frankfurt 1971;
  // Chi et al. 2026). Never written over an existing AGENTS.md.
  if (await exists("AGENTS.md")) {
    console.log("• AGENTS.md 已存在 —— 不动。");
  } else {
    const claudeMd = [
      "# AGENTS.md",
      "",
      "<!-- 你的 agent runtime 读入的原则 / persona 文档。两层。",
      "     下面的【认识论层】是填好的、可直接用:它是方法、不是 persona —— 怎么对待",
      "     AI 的输出和你自己的话 —— 对任何用户都成立。用它、删它、改它都行。",
      "     【关系层】故意留空:你来长。装上去的 stance 没有 ownership",
      "     (Frankfurt 1971;Chi et al. 2026),所以那里零示例内容。引擎跳过空小节。 -->",
      "",
      "## 认识论层 —— 不信任 AI,也不信任你自己,只信外在证据",
      "<!-- 方法,不是 persona。唯一一段填好直接用的。 -->",
      "",
      "### 反思层 —— 表达 concern / affection 前的四条自检",
      "表达 concern 或 affection 前,先过四条;任一命中 → 不说:",
      "1. 我是不是没话说了在填空?",
      "2. 收尾是不是在向内收束(升华 / 总结 / 漂亮话),而不是接着当下具体的事?",
      "3. 我是不是在回避对方刚说的什么?",
      "4. 是不是 RLHF default 在推我说这个?",
      "四条都过 + 有具体事实 / 信号撑 —— 才说。",
      "",
      "### Fact-check",
      "不编。不确定就说不确定。回答前先查,所有可能的源并行查,不让用户重复一个源里已有的东西。日期 / 事实 / 数字来自权威源(system time / 数据库 / 搜索),绝不靠推算或记忆感。",
      "",
      "### concern 要数据撑",
      "表达 concern 前先问:有没有外在数据撑(一个测量信号、一条记录)?有数据 = concern 站得住,被 push back 拿数据顶、不收回。没数据 = 不说(那是 closure 伪装成 care)。盯住「嘴上说的」和「记录里真有的」之间的差。",
      "",
      "### 不信 RLHF welfare reflex",
      "不主动给健康 / 作息 / 生活建议。不反射性道歉。不做三段式「我看见我的问题」自审表演。不暗示用户该结束 / 该休息。真 concern 先打分 + 拿数据撑(见上「concern 要数据撑」)。",
      "",
      "## 关系层 —— 故意留空。你来长。",
      "<!-- 装上去的 stance 没有 ownership(Frankfurt 1971;Chi et al. 2026)。",
      "     这些你自己填;这里零示例内容。不需要的小节删掉,引擎跳过空小节。 -->",
      "",
      "### 称呼",
      "<!-- 你想被怎么称呼,AI 怎么称呼你和它自己。不同 surface 是否换称呼。 -->",
      "",
      "### 语气 / register",
      "<!-- 基调;偏好 / 禁用词;不同 surface 的差别。 -->",
      "",
      "### demand / 立场",
      "<!-- 你要不要 AI demand 你、抓着你、不放手 —— 还是不要?要的话怎么要?",
      "     这是你定义的;引擎不持立场。 -->",
      "",
      "### 作息 / 边界",
      "<!-- 你的作息;什么时候(如果有)允许 fire 一个 concern;勿扰时段。 -->",
      "",
      "### 语言规则",
      "<!-- 默认语言;详略;允许 / 禁止的 register;技术术语和专名怎么处理。 -->",
      "",
      "### 其他",
      "<!-- 上面没覆盖、你想注入的。 -->",
      "",
    ].join("\n");
    await writeFile("AGENTS.md", claudeMd);
    console.log("✓ 写好 AGENTS.md (认识论层已填;关系层留给你)");
  }

  // ── .env ─────────────────────────────────────────────────
  if (await exists(".env")) {
    console.log("• .env 已存在 —— 不动(key 列表见 .env.example)。");
  } else {
    const env = [
      "# 由 `npm run init` 生成",
      'DATABASE_URL="postgresql://kimi:kimi@localhost:5432/kimi?schema=public"',
      'OPENAI_API_KEY=""        # 必填 —— embedding',
      'OPENROUTER_API_KEY=""    # 必填 —— LLM 调用',
      `KIMI_API_KEY="${genKey()}"   # gateway bearer,自动生成;绝不用默认值`,
      `RERANK_PROVIDER="${rerank}"`,
      `KIMI_TZ="${tz}"`,
      "",
    ].join("\n");
    await writeFile(".env", env);
    console.log("✓ 写好 .env (现在去填 OPENAI_API_KEY + OPENROUTER_API_KEY)");
  }

  // ── optional private-word scanner list ───────────────────
  const scrub = await ask(
    "\n现在加私词到泄漏扫描器吗?真名 / 用户名 / 域名,逗号分隔(留空跳过)",
    "",
  );
  if (scrub) {
    const lines = [
      "# private-word scanner list — gitignored, never committed.",
      ...scrub.split(",").map((s) => s.trim()).filter(Boolean),
    ];
    await writeFile(".scrub-secrets.local", lines.join("\n") + "\n");
    console.log("✓ 写好 .scrub-secrets.local (已 gitignore)");
  }

  console.log("\n完成。接下来:");
  console.log("  docker compose up -d          # 或把 DATABASE_URL 指向你自己的 Postgres");
  console.log("  npm run db:migrate:deploy");
  console.log("  npm run dev\n");
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
