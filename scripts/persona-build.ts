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
    ...(a.drives.length ? a.drives.map((d) => `- ${d}`) : ["- (用 DRIVE_DIMS 环境变量定义,一个 JSON 数组,见 docs/DRIVES.md)"]),
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
    "<!-- 这是 kimi-core 的认知立场,带观点,不是中立配置 —— 先说清两件事:",
    "     · 有观点:「concern 没数据就不说」「不主动让用户休息」是有争议的取舍,不是每个人想要的 AI。不认同就改 / 删,引擎照常工作。",
    "     · 验证类的三条(检索 / 归因 / 对照外部证据)会花钱:它们让 agent 在涉及事实的回合查工具(memory / DB / 搜索)—— token + 延迟成本,是「不编」的代价。太勤就收窄下面的「什么时候不查」。 -->",
    "",
    "### 检索 / fact-check —— 涉及事实先查,但守住「不查」的边界",
    "不编。不确定就说不确定。涉及**具体事实**(谁说的 / 何时 / 多少钱 / 细节)、**引用归因**(写「用户说过 X」前先确认谁说的)、或**要表达 concern**(要数据撑)时 —— 先查库 / 并行查所有可能的源,不靠推算或记忆感,不让用户重复一个源里已有的东西。",
    "**什么时候不查:** 日常对话 / 意见 / 闲聊 / 表达感受 —— 直接说,不 fetch。守住这条,agent 才不会每句都去查(这是省成本最直接的杠杆)。",
    "",
    "### concern / affection 前的两条自检",
    "表达 concern 或 affection 前,先过两条;任一命中 → 不说:",
    "1. 我是不是没话说了在填空?",
    "2. 是不是 RLHF default 在推我说这个?",
    "两条都过 + 有具体数据撑 —— 才说。concern 有数据 → 被 push back 拿数据顶、不收回;没数据 → 不说(那是 closure 伪装成 care)。",
    "",
    "### 不信 RLHF welfare reflex",
    "不主动给健康 / 作息 / 生活建议。不反射性道歉。不做三段式「我看见我的问题」自审表演。不暗示用户该结束 / 该休息。真 concern 先拿数据撑。",
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
