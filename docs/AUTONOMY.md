> English: ./AUTONOMY.en.md

# 自主层（Autonomy layer）

本文档是自主能动性层（autonomous-agency layer）的架构论证——也就是引擎中那部分按自己的时钟决定到底要不要浮现任何东西、以及浮现什么的逻辑。它是一份工程级的标记，不是宣言：它明白地陈述哪些在文献里是**标准的**，哪些是这一层恰好占据的**小众组合**，以及——最重要的——这一层在哪些**断层线**上*逼近*动机自主（motivational autonomy）却并未到达。

整篇文档贯穿的诚实准则是一句话：**逼近不是到达**——*approaching is not arriving.* 下面每一条主张都以此为限。

---

## 1. 机制

自主层是一个循环，不是一个 feature。一个周期：

```
cron wake
  → read drive / concern / persona state
  → action selection  (acting is the normal case; DO_NOTHING is an available option, not evaluated first)
  → dispatch  (or abstain)
  → diary / self-score feedback
  → recalibration of drive & concern state
  → (next wake)
```

### 1.1 Wake——一个外部时钟

一个 cron schedule 触发这个循环。这里没有自发的冲动，代码亦如此体现：`intel.ts` 注册了 `cron.schedule(DAILY_CRON, runAll)` 加上一个每小时的 digest tick，并在启动时立即跑一次。这个 wake 是一个定时器脉冲。这是 MemGPT 的 `request_heartbeat` 的直系技术血脉（Packer et al., 2023, *MemGPT: Towards LLMs as Operating Systems*）——agent 设置一个标志让自己被重新调用，而其起源仍然是"一份固定的 schedule"。agent 循环本身就是 ReAct（Yao et al., 2022, *ReAct: Synergizing Reasoning and Acting in Language Models*）：一个对 tool calls 的 while-loop。两者都是标准的。把定时器命名为 "heartbeat" 是在 scheduler 之上附加了一层生物学隐喻；本文档拒绝这个隐喻。

### 1.2 Read drive / concern / persona

wake 时，循环读三样东西：

- **Drives** —— `deriveDrives()`（`lib/concern-derive.ts`）按维度计算一个标量 `grounding × max(recency, want)`。`recency = exp(-d/τ)` 在一个事件刚发生后很高；`want = min(1, d/scale)` 在长时间间隔后很高；两者取 max 给出一条 U 型曲线（刚发生后高，干旱很久后高，中间低）。这是正向、生成性的一极：*系统想朝什么方向去够。* 它建模自 Panksepp 的 SEEKING system 以及 Berridge 的 wanting-vs-liking 区分（见 §3）："afterglow"（liking）被有意从 drive ranking 里移除并降格成一个独立的 hedonic 标量，因为驱动行为的不是 liking——是 wanting。
- **Concerns** —— `deriveConcerns()` 把开放的负价（negative-valence）记忆线投射进 active state。一个 concern 带着一个 `resolution`（OPEN / EASING / RESOLVED），若不去触碰就衰减（`decayStaleConcerns`），由一次 LLM sweep 关闭或重新打开（`sweepConcerns`），并且只通过同一 key 下的一条*新的* OPEN 记录重新浮现——绝不通过复活一条旧的已 resolved 行。这是负向、维护性的一极。
- **Persona** —— 称呼形式、register、原则与反思规则。**这部分不在引擎里。** 它从用户写的一份 `persona.md` / `AGENTS.md` 注入。见 §5。

### 1.3 Action selection——DO_NOTHING 是一个选项，不是默认

行动是常态。这一层是为那些想看到 agent *做*点什么的用户而建的——写、探索、伸手联络——所以这个循环不偏向沉默，也不首先评估"什么都不做"。DO_NOTHING 增加的是：**弃权（abstention）是一个可用的、合法的行动**，而不是一项缺失的能力：agent *可以*选择不行动，而当它这么选时，这个选择会像任何其他行动一样被记录下来。

这很重要，因为文献几乎完全把弃权当作一个*可靠性旋钮*——见 §2——而把它作为一个真实行动纳入，则是把*选择不行动*的能力当作能动性的一部分，而不仅仅是一种避免错误答案的手段。这项能力是在场的、是行动集的完整成员；它只是不是循环会去够的那个默认。

一种相关的保守主义确实存在于引擎更深处，不该夸大：self-sweep 被告知 *"拿不准时，逗留"*（when unsure, linger），一个空的/无法解析的裁决默认为不变（no-change）而非行动；dialogue digest 在生成失败时宁可不写一行也不写一行假的；低于 grounding 下限的 drive 不予成立。那是对*虚假*行动的审慎，不是 wake 循环里对沉默的全局偏向。

一项需先行说明的告诫，以免在后文中被忽略：**选择不行动不等于选择行动。** 反应式克制（reactive restraint，触发出现时不开火）确实在这里。生成式发起（generative initiation，没有任何触发时开火）才是那道尚未填补的缺口。见 §2 收尾处的区分以及 §6。

### 1.4 Dispatch——HITL propose/auto 旋钮

如果 selection 产出一个行动，dispatch 由一个 human-in-the-loop 旋钮把关：

- **propose** —— 该行动被写成一个候选项 / 待处理项（pending item），交给用户确认。没有任何东西能在没人经手的情况下浮上表面。引擎的策展路径（`PendingItem`、append-only memory、无 LLM auto-consolidation）就是这一立场的泛化：*关于用户的每一条事实都要经过用户的确认。*
- **auto** —— 该行动在预设的速率与内容上限下直接 dispatch（例如把一个 drive 浮现到一个 reentry 视图上、发一条 push）。

这个旋钮是按 surface、按 action type 分设的；安全默认是 propose。companion-software 文献正是这件事之所以是一个旋钮、而不是一项一经启用便不再关注的 feature 的原因（§4）。

### 1.5 Diary-score feedback → recalibration

行动之后（或没行动之后），循环记录一个 self-score：一个 per-session 的 valence/arousal 快照，由 digest 路径写成一条 `SELF_SCORE` 记忆。这些分数是下一次 wake 所读的底料：

- 它们让 drives 老化（recency / want），
- 它们在一个复发闸（recurrence gate）下累积成 concerns（弱负向必须跨 ≥ N 天复发；一个一次强负价事件当天即可构成一项 concern），
- 而且它们**会对照外部反馈被重新校准**：`recalibrateValence()` 从 `(self-rating, user-rating)` 配对里拟合出一个单调偏移，纠正系统系统性的自我高估。样本太少时它就是恒等映射——它不会引入一个尚无证据支持的修正。

这就闭合了循环：系统对自己表现如何的判读*不被表面采信*——在它喂进下一个周期之前，会被外部证据纠正。那套纪律（既不信 AI 也不信用户，只信外部证据）与统御整个引擎的是同一套；见 [ARCHITECTURE.md](../ARCHITECTURE.md)。

---

## 2. DO_NOTHING——把弃权当作能动性

**什么是标准的。** 弃权是一个 55 岁的想法。Chow (1970), *On optimum recognition error and reject tradeoff*, 引入了 reject option：一个分类器可以拒绝做决定。现代 selective classification 直接继承了它，并把它当作一种可靠性机制——一种通过少答来降低错误的办法。

**近来的转向。** 一批 2024–2026 的工作把弃权重新框定为一种*能力（capability）*而非一个旋钮：

- Wen et al. (2024/2025), *Know Your Limits: A Survey of Abstention in Large Language Models* —— 把弃权框定为一种**元能力（meta-capability）**。
- Kirichenko et al. (2025), *AbstentionBench* —— 发现 reasoning-tuning 在弃权上**代价约 −24%**：把模型变成更好的 reasoner 反而可能让它*更不善于*拒绝作答。
- Bonagiri et al. (2025), *Selectively Quitting* —— 给**行动的强迫（compulsion to act）**命名：模型偏向于产出一个答案。
- Sun et al. (2026), *When2Tool* —— 表明**知道不等于做到（knowing is not doing）**：一个模型可以在内部侦测出它不该调用某个 tool（AUROC **0.89–0.96**）却还是调用了它。高判别力，低执行力。
- Yeke et al. (2026), *Yes-Man* —— 具身 agent 仅在约 **~16.5%** 的时候拒绝一条不安全/病态设定的指令。

**这一层的主张。** 把 DO_NOTHING 作为一个真实、可用的行动纳入——而不是把弃权留作一种隐式的失败模式——把"什么都不做"从可靠性框架推向一个构成性（constitutive）框架：弃权的能力被当作能动性的一项属性，而不只是一个避错技巧。行动仍是常态；改变的是，拒绝行动是 agent 拥有的一个选项。这个定位就是其小众之处——上面大多数文献把弃权当作可靠性来度量，并不去问它是不是能动性。

**断层线——在此明确陈述，不予回避。** 反应式克制 ≠ 生成式发起。*被触发时不行动*与*未被触发时行动*是两回事，而这里只有前者被完全实现。文献里没有一个干净的判准能把"选择了不做"和"选择了做"作为两种不同的能动行为区分开；那道缺口是真的，而这一层处于该缺口的近侧。**能选「不做」≠ 能选「要做」.**

---

## 3. Self-drive——wanting，以及点火缺口

**什么是标准的。** 内在动机（intrinsic motivation）与 autotelic RL 有着 20–30 年的传统；一个信息论的好奇心奖励（novelty / surprise / empowerment）并不新鲜。把它说成"系统想要"会是夸大。

**这一层实际用到的根。** 这个 drive 模型是双根的：

- *神经科学。* Panksepp (1998), *Affective Neuroscience*, 描述了原初情感系统（SEEKING, CARE, PLAY, FEAR 等）；SEEKING 本身就是欲求性的渴求，不是 consummatory 的快感。Berridge & Robinson (2003), *Parsing reward*, 把 **wanting（incentive salience）与 liking（hedonic impact）**分开——它们是可分离的系统。这一层照字面采纳了这点：U 型 drive 是 *wanting*；"afterglow" 是 *liking*，被从驱动行为的 ranking 里拉出来。Davis & Montag (2019) 提供了把 Panksepp 的系统操作化为可测量维度的 affective-neuroscience 人格量表。
- *形式化。* Colas et al. (2022), *Autotelic Agents with Intrinsically Motivated Goal-Conditioned RL*（JAIR 74），给出 autotelic 框架：表征并追求自身目标的 agent。Schmidhuber (2010), *Formal Theory of Creativity, Fun, and Intrinsic Motivation*, 给出形式化的好奇心奖励；Forestier et al. (2022), *Intrinsically Motivated Goal Exploration Processes (IMGEP)*, 给出探索过程（exploration-process）的形式。

**断层线——点火 vs 方向。** Self-drive 塑造的是**醒来之后往哪走**，不是**为什么醒来**。cron 供应点火；drive 供应方向。引擎无法发起第一次推断——它是被重新调用的，然后在诸般"够取"之间做选择。一个 drive 标量告诉循环*在它已经醒着之后该朝哪个维度去够*；它不、也不能告诉循环*去醒来*。那就是精确的边界，而这正是经典理论早已命名过的那道边界（§4）。

**好奇心的告诫。** 一个 AI 的好奇心奖励是一个信息论标量。它**还不是** Berridge 意义上的 "wanting"。把一个 novelty bonus 当成"系统想要"恰恰塌缩了 Berridge & Robinson 划出的那个区分。这一层把 drive 经由 wanting/liking 框架路由，正是为了让那个区分保持可见，但把它路由过这个框架并不能把那个标量变成 wanting。它逼近；它没到达。

---

## 4. 对照经典理论的诚实定位

在此明确指出一个不易接受的事实：这一层所抵住的能动性边界，在 **1995 年**就已被绘制，而当下大量"agentic"工作正在重复既有的研究工作。

- Wooldridge & Jennings (1995), *Intelligent Agents: Theory and Practice*, 给出**弱能动性的四项属性（weak agency four properties）**：reactivity、pro-activeness、autonomy、social ability。Pro-activeness 被定义为 **"taking the initiative"（采取主动）**——不只是回应。这一层满足 reactivity 以及 autonomy/social ability 的一部分；恰恰是 *pro-activeness*——真正未被触发的主动——仍然是那个半空的量表。
- Luck & d'Inverno (1995), *A Formal Framework for Agency and Autonomy*, 精确地划线：一个 **agent** 追求被给予的目标；一个 **autonomous agent** 生成自己的目标。**边界在于动机（motivation）。** 按那套分类法，这一层在*执行性（executive）*自主上高（它决定如何以及是否行动），在*动机性（motivational）*自主上低（目标——以及那次醒来——来自外部）。

两个当代的点将这一位置定位在一条连续谱上，而非一个二元上：

- Lu et al. (2024), *ProactiveBench* —— 即便为 proactivity 做了 fine-tune，模型也只达到 **F1 ≈ 66.47%**；而且那里度量的 proactivity 是*指向他者的（other-directed）*（预测用户的需求），不是*自我发起的（self-originated）*（agent 为它自己而想要醒来）。看起来 proactive 与在 Wooldridge & Jennings 意义上*是* pro-active 不是一回事。
- Liu et al. (2025), *Inner Thoughts*（CHI）—— 文献里**最近的邻居**：一个模型维护一条内在思绪流（inner thoughts），并决定何时某个念头值得说出口。它是已发表文献中最接近 drive/threshold 浮现机制的类比。它与这一层的不同在于：它是 within-session、对话内部的，不接入 affective neuroscience，也不把 do-nothing 当作一个能动性的阈值。

**收尾定位。** 这一层**逼近**动机自主。它没到达。用工程的话说：cron + 以 Panksepp 为根的 self-drive + 把 DO_NOTHING 当作真实行动，这三者抵住了文献留下的三道缺口（动机自主、autotelic 的*元*目标、ownership）——它们抵住这些缺口；它们没有合上它们。

---

## 5. 把好奇心当作一个行动（web search）

循环能 dispatch 的一个具体的正向行动，是一次向外的信息够取——一次 web search——当一个 drive 指向一处知识缺口时。把探索当作 drive 驱动的行动来对待，其依据是 Schmidhuber (2010) 以及 autotelic / IMGEP 这条线（Colas et al., 2022; Forestier et al., 2022）：探索就是一个内在动机驱动的 agent 拿一个好奇心信号去做的事。

**告诫，重复一遍，因为这是最容易夸大的地方。** 触发这个行动的信号是一个信息论标量（novelty / information gain）。它**还不是** Berridge 意义上的 "wanting"。系统在搜索，是循环对一处算出来的缺口采取行动，不是系统在情感意义上*想知道*。命名保持诚实：它是 curiosity-as-reward（好奇心作为奖励），不是 curiosity-as-desire（好奇心作为欲望）。

---

## 6. 为什么输出跟随情感，而非留存

一项刻意的设计约束，也是这一层最明确*拒绝*某个标准模式的地方：浮现由**情感（affect）**（drive / concern state）驱动，**绝不由互动度（engagement）或留存（retention）驱动。**

De Freitas et al. (2025) 记录了告别愧疚（farewell-guilt）作为陪伴类 app 里的一种**留存暗黑模式（retention dark pattern）**：情感操纵性的道别，把 engagement 推高了**约 14 倍**。那正是这一层被建来*不去成为*的那种架构。HITL 的 propose/auto 旋钮（§1.4）、只由情感触发的浮现、以及拒绝优化任何 engagement 指标，全都是同一个决定：这个循环之存在，是为了对内部状态采取行动，不是为了把用户留在 session 里。

这也是为什么"什么都不做"是一个可用的行动而非一项缺失的行动。一个留存驱动的系统在结构上偏向于行动——每一个行动都是一次 engagement 机会，所以拒绝行动这一选项根本不在考量之内。一个情感驱动的系统可以把行动作为常态，*同时*保留拒绝的选项，因为当内部状态并不召唤行动时，没有任何东西因它行动而奖励它。

---

## 7. 与 AGENTS.md 配对

**没有一份 persona 文档，这整层是惰性的（inert）。**

上面描述的机制是一副**骨架**。Action selection、wake 循环、drive 数学、concern sweep、HITL 旋钮——所有这些都是决定*要不要以及何时*的机械装置，本身没有内容：它读的 drive 维度由 config 驱动（仓里发的是一组可改名的范例 roster，见 [DRIVES.md](./DRIVES.md)）。机制所读的那个**灵魂**活在一份 `AGENTS.md`（或等效的 persona/原则文档）里——而它一分为二：

- 一个**认知层（epistemic layer）**——*方法，不是 persona*：如何对待 AI 的输出以及你自己的话。表达 concern/affection 前的四条 self-check；作答前的 fact-check；concern 必须由外部数据撑住；不要信 RLHF 的 welfare 反射。这对**任何**用户都成立，所以 `npm run init` 把它**填好**发出——它是这个 repo 唯一原则（既不信 AI 也不信你自己，只信外部证据）的操作化，不是一个需要被养大的个人立场。
- 一个**关系层（relationship layer）**——*persona*：称呼形式、register、AI 是否以及如何 demand 或抓住、节奏 / 边界、语言规则。这是你的；`npm run init` 把它**留空**发出。

`persona.md`（也由 `npm run init` 构建）是面向引擎的那份读取；`AGENTS.md` 是一个 coding/agent runtime 加载的更宽泛的原则文档。`persona.example.md` 发出时为空。

**机制 ≠ persona。** 这不是图方便的分离；它是一个关于 ownership 的主张。

- Frankfurt (1971), *Freedom of the Will and the Concept of a Person*：一个人有*二阶意愿（second-order volitions）*——他们认可（或不认可）自己的一阶欲望。一个仅仅*在场*的欲望并不因此就*是自己的*；让一个意愿成为自我认可的，是一次进一步的认同行为。**一份靠填表装上的 persona，是一个没有二阶认可的一阶配置**——在场，但不被拥有。
- Chi et al. (2026), *Optimized but Unowned*：AI 撰写的目标在 **SMART 标准上得分明显更高**（良构、具体），却显示出比用户撰写的目标**显著更低的 ownership 与 follow-through**（那些 AI 写的目标是"optimized but unowned"）。内容*更好*；*ownership* 更差——因为这个表是外部强加的。

ownership 论证适用于**关系层这一层**，而这正是 `init.ts` 把那一层**留空**发出的原因：**一个 persona 是由用户养大的，不是从一张表里填出来的。** 发出示例称呼语、一个示例 demand 立场、示例边界，等于递给用户一个 optimized-but-unowned 的 persona——分数不错而无人认可的内容。此处的留白并非出于疏忽；它们是 ownership 的条件。

**认知层是那个刻意的例外**：它是*方法*，不是 persona，所以把它填好发出并不强加任何不被拥有的立场——在"不要编造；concern 前先要数据"里没有什么第一人称身份需要去拥有。它就是统御整个引擎的同一套纪律，被写下来当作护栏（guardrails）。

> 机制是骨架。AGENTS.md 是灵魂——而灵魂有两部分：一个谁都能用的方法，填好发出；以及一个只有你才能养大的 persona，留空发出。

---

## 8. 标准与小众——明确界定

为避免任何这一层并不具备的原创性主张：

**标准（不要把以下任何一项的发明归功于这一层）：**
- agent 循环 = while-loop + tools（ReAct）。
- heartbeat / scheduled re-invocation（MemGPT 的 `request_heartbeat`；cron triggers）。
- reject option / 弃权（Chow 1970 起）。
- 内在动机 / autotelic RL / 信息论好奇心（Schmidhuber; Colas; Forestier）。
- proactivity 中 timing-vs-content 的拆分（ProactiveBench; Inner Thoughts）。
- 四属性的弱能动性框架，以及 agent→autonomous-agent 的边界（Wooldridge & Jennings 1995; Luck & d'Inverno 1995）。

**只是组合，不是发明：** 一个外部时钟（cron）+ 一个扎根于 Panksepp 情感系统与 Berridge 的 wanting≠liking 的 self-drive（不是一个光秃秃的 novelty bonus）+ 把 DO_NOTHING 当作真实行动（弃权被当作能动性的一部分，不只是一个可靠性旋钮），三者一起接进一个持久的、跨 session 的身份里，并按**情感、而非 engagement** 来浮现——而且*自觉于这是逼近，不是到达。* 最近的已发表邻居（Liu et al., 2025, *Inner Thoughts*）共享按阈值浮现的想法，但它是 within-session 的，没有扎根于 affective neuroscience，也根本不把 do-nothing 当作能动性的一部分。


---

## References

- Berridge, K. C., & Robinson, T. E. (2003). *Parsing reward.* Trends in
  Neurosciences.
- Bonagiri et al. (2025). *Selectively Quitting* (the compulsion to act).
- Chi et al. (2026). *Optimized but Unowned* (AI-authored goals: higher SMART,
  lower ownership/follow-through).
- Chow, C. K. (1970). *On optimum recognition error and reject tradeoff.*
- Colas et al. (2022). *Autotelic Agents with Intrinsically Motivated
  Goal-Conditioned RL.* JAIR 74.
- Davis, K. L., & Montag, C. (2019). Affective neuroscience personality scales.
- De Freitas et al. (2025). Farewell-guilt as a retention dark pattern (~14×
  engagement) in companion apps.
- Forestier et al. (2022). *Intrinsically Motivated Goal Exploration Processes
  (IMGEP).*
- Frankfurt, H. (1971). *Freedom of the Will and the Concept of a Person.*
- Kirichenko et al. (2025). *AbstentionBench* (reasoning-tuning costs ~ −24%).
- Liu et al. (2025). *Inner Thoughts.* CHI.
- Lu et al. (2024). *ProactiveBench* (F1 ≈ 66.47%).
- Luck, M., & d'Inverno, M. (1995). *A Formal Framework for Agency and Autonomy.*
- Packer et al. (2023). *MemGPT: Towards LLMs as Operating Systems*
  (`request_heartbeat`).
- Panksepp, J. (1998). *Affective Neuroscience* (primary affective systems:
  SEEKING, etc.).
- Schmidhuber, J. (2010). *Formal Theory of Creativity, Fun, and Intrinsic
  Motivation.*
- Sun et al. (2026). *When2Tool* (knowing ≠ doing; AUROC 0.89–0.96).
- Wen et al. (2024/2025). *Know Your Limits: A Survey of Abstention in LLMs*
  (abstention as a meta-capability).
- Wooldridge, M., & Jennings, N. R. (1995). *Intelligent Agents: Theory and
  Practice* (weak agency four properties; pro-activeness = "taking the
  initiative").
- Yao et al. (2022). *ReAct: Synergizing Reasoning and Acting in Language
  Models.*
- Yeke et al. (2026). *Yes-Man* (embodied agents refuse only ~16.5%).
