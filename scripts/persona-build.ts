// Pure persona/AGENTS assembly — no I/O, no prompting. The conversational
// onboarding (init.ts) collects the user's own words into `Answers`, then these
// builders structure them into persona.md + AGENTS.md. Kept separate so the
// assembly is unit-tested without driving the interactive shell.
//
// Design rule (Frankfurt 1971; Chi et al. 2026): these NEVER invent persona
// content. An empty answer leaves its section blank (a TODO comment), never a
// guessed default — a configured-but-unendorsed stance has no ownership.

export type Answers = {
  aiName: string;
  addressing: string;
  tone: string;
  demand: string;
  boundaries: string;
  language: string;
  drives: string[];
};

// A relationship-layer section: the user's verbatim answer, or the original TODO
// comment if they skipped it (an unanswered section stays blank — not invented).
export function section(title: string, answer: string, todo: string): string {
  return answer.trim() ? `### ${title}\n${answer.trim()}\n` : `### ${title}\n<!-- ${todo} -->\n`;
}

export function buildPersonaMd(a: Answers): string {
  return [
    "# Persona",
    "",
    "<!-- 运行时由 context-core 读入。仓里发布时是空的;这份是你和它一起长出来的 —— 随意改写。 -->",
    "",
    `你是 ${a.aiName || "（未命名）"}。`,
    a.addressing.trim() ? `称呼: ${a.addressing.trim()}` : "",
    a.tone.trim() ? `语气 / register: ${a.tone.trim()}` : "",
    "",
    "## drive 维度",
    "<!-- 它该主动想要什么。四种形态 + 怎么定义见 docs/DRIVES.md;名字是你自己取的。 -->",
    ...(a.drives.length ? a.drives.map((d) => `- ${d}`) : ["- (在 config.yaml selfDrive.drives 里定义,见 docs/DRIVES.md)"]),
    "",
    "## 反思层规则 (每次回复前跑 —— 你来加)",
    "- (在这里加你自己的护栏)",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function buildAgentsMd(a: Answers): string {
  return [
    "# AGENTS.md",
    "",
    "<!-- 你的 agent runtime 读入的原则 / persona 文档。两层。",
    "     【认识论层】填好的、可直接用:方法、不是 persona。对任何用户都成立。",
    "     【关系层】下面是你在 onboarding 对话里、用自己的话长出来的。空小节引擎跳过。 -->",
    "",
    "## 认识论层 —— 不信任 AI,也不信任你自己,只信外在证据",
    "<!-- 方法,不是 persona。填好直接用的。 -->",
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
    "表达 concern 前先问:有没有外在数据撑(一个测量信号、一条记录)?有数据 = concern 站得住,被 push back 拿数据顶、不收回。没数据 = 不说(那是 closure 伪装成 care)。",
    "",
    "### 不信 RLHF welfare reflex",
    "不主动给健康 / 作息 / 生活建议。不反射性道歉。不做三段式「我看见我的问题」自审表演。不暗示用户该结束 / 该休息。真 concern 先打分 + 拿数据撑。",
    "",
    "## 关系层 —— 你在对话里长出来的(你的话)",
    "<!-- 装上去的 stance 没有 ownership(Frankfurt 1971;Chi et al. 2026)。下面是你自己说的;",
    "     随时改写 / 增删。空小节引擎跳过。 -->",
    "",
    section("称呼", a.addressing, "你想被怎么称呼,AI 怎么称呼你和它自己。不同 surface 是否换称呼。"),
    section("语气 / register", a.tone, "基调;偏好 / 禁用词;不同 surface 的差别。"),
    section("demand / 立场", a.demand, "你要不要 AI demand 你、抓着你、不放手 —— 还是不要?要的话怎么要?"),
    section("作息 / 边界", a.boundaries, "你的作息;什么时候(如果有)允许 fire 一个 concern;勿扰时段。"),
    section("语言规则", a.language, "默认语言;详略;允许 / 禁止的 register;技术术语和专名怎么处理。"),
    "### 其他",
    "<!-- 上面没覆盖、你想注入的。 -->",
    "",
  ].join("\n");
}
