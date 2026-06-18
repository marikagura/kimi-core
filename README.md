> English: ./README.en.md

# kimi-core

一个**个人用的 agent memory OS** —— 一人对一个 AI（1v1）的 agentic 记忆 + self-drive 引擎，内置一套对抗式自审 harness。

关于架构设计请读 **[ARCHITECTURE.md](./ARCHITECTURE.md)**——下面这些都只是零件。
关于 autonomous-agency 层（cron wake → drive/concern → action selection，DO_NOTHING 是一个选项而非默认 → dispatch），
请读 **[docs/AUTONOMY.md](./docs/AUTONOMY.md)**——架构论证、完整 citations，以及诚实的断层线。
搭 surface 时的工程模式（prompt caching / retry / 凭证轮转）见 **[docs/PATTERNS.md](./docs/PATTERNS.md)**。

> **状态：引擎完整，有测试有文档。** hybrid retrieval、self-drive / concern、可复现 eval、对话式
> onboarding、参考投递 providers、对抗式自审 harness 都已落地（tsc + test + scrub 在 CI 里跑）。
> autonomous wake daemon 已接线、有单元测试；真正跑它要订阅 token + 两进程拓扑（见下「运行 autonomous daemon」）。

## 它是什么

- **Hybrid retrieval** —— dense（pgvector）+ lexical（BM25 / trigram）+ 时间衰减 + 重要度，四信号
  加权（entity-mention 是关键词臂的加成 + 过滤旁路，单跳；多跳 `graph_walk` 是独立工具，不进排序），
  外加一个可选的 cross-encoder rerank 阶段。
- **Active self-drive** —— Panksepp 式的情感 drives，会主动地把记忆 *surface* 出来，外加一个
  concern 引擎（open / resolved · decay · recurrence · grounding）。
- **Event sourcing + append-only + 人工 curation** —— 没有 LLM 自动 consolidation（它的 failure mode 是
  静默腐蚀）。每一条关于你的 fact 都要过你自己的手并经你确认。
- **可复现的 retrieval eval** —— hit@5 / hit@10 / MRR / nDCG@10 / set-recall@10，带
  hard-negative 负控（expectNone）和 reranker / 组件 A/B。按 keyword 标注（不绑 row-id，
  re-seed 库也不失效），每跑写一条趋势 Event。这些数字你可以自己重跑。
- **对抗式自审 harness** —— 用一组 agent 对准你自己的 fork 去查 leak 和 bug，
  带 *行为级* 验证。（Static inference 会系统性地 over-claim——这是吃过亏学来的。）

## 它做什么（一个具体例子）

（下面是虚构的示例用户。）

三天前你跟它说在赶一个叫 Helios 的项目、周五 deadline。今天一次定时 wake 里，self-drive 的「陪伴」维度涨起来（距上次聊很久了），concern 引擎也盯上了那个临近的 deadline——于是它 surface 出来的不是泛泛问候，是「Helios 周五就到了，昨天那版 demo 卡在哪？」。因为它**检索**到了那条记忆，而且关心**grounding 在你真说过的话**上。

这个例子里有三点：记忆可检索、关心有数据撑、主动**按情感不按 engagement** 触发。`apps/gateway/src/eval/retrieval_cases.example.json` 是一份虚构示例集，`npm run eval` 跑它给你 hit@ / MRR / nDCG；一份真实样例输出 + 一段 reentry / diary 快照见 **[docs/EXAMPLE.md](./docs/EXAMPLE.md)**。

## 快速开始（本地）

```bash
npm install
docker compose up -d          # local Postgres + pgvector — or point DATABASE_URL at your own DB
npm run init                  # conversational onboarding — generates .env (with a fresh KIMI_API_KEY) + persona.md + AGENTS.md
                              # (prefer to do it by hand? cp .env.example .env and fill it instead)
# now open .env: set your LLM endpoint (LLM_BASE_URL + LLM_API_KEY) + KIMI_MODEL — the repo presets none;
# EMBED_BASE_URL + EMBED_API_KEY + EMBED_MODEL enable semantic search
npm run db:migrate:deploy
npm run dev                   # starts the gateway (HTTP MCP server) on :3001
```

这个 repo 里没有内建的人格，没有示例关系，没有词表。
`npm run init` 会带你一步步把它建起来。

**model 和 provider 都不附带。** 两样都不预设:LLM 端点用 `LLM_BASE_URL` + `LLM_API_KEY`
(任何 OpenAI 兼容端点——OpenRouter / OpenAI / 本地 vLLM·Ollama 都行)+ 一个 `KIMI_MODEL`
(那个端点认的模型 id);语义检索用 `EMBED_BASE_URL` + `EMBED_API_KEY` + `EMBED_MODEL`;跑 daemon
才需要 `DAEMON_MODEL`(裸 Claude id)。`npm run init` 会问你;没设就 fail-closed、报一条清楚的错,
而不是悄悄拿一个你没选过的端点或模型去跑。

## 运行 autonomous daemon（可选）

引擎是两个进程：**gateway**（HTTP MCP 服务，`npm run dev` 起在 :3001，记忆 / 工具都从这里走）+ 一个 **wake daemon**（按 cron 醒来、读 drive / concern、决定做什么）。daemon 是可选的——不跑它，引擎照样是个完整的记忆 + 检索后端。

```bash
# 终端 1：gateway（必须先起）
npm run dev
# 终端 2：daemon
cd apps/gateway
npm run daemon          # 按 cron 持续跑（生产里用 pm2 等守护进程）
npm run daemon:wake     # 只立刻跑一次 wake —— 用来验证
```

**作者的daemon 用 Claude Agent SDK**，所以它需要一个 Claude（Anthropic）订阅 token：`claude setup-token` 生成，填进 `.env` 的 `CLAUDE_CODE_OAUTH_TOKEN`。引擎其余部分是 provider 无关的（LLM 和 embedding 都走你自己配的兼容端点 `LLM_BASE_URL` / `EMBED_BASE_URL`）——**只有这条自主 wake 循环绑 Claude**；用别的 agent runtime 就换掉 daemon 那一层，引擎不动。

> 诚实交代：作者端到端验证过引擎 + eval；完整的 daemon wake 循环（接线 / model / 传输都已对齐）请你用自己的 token 在自己机器上确认一次。

## 存储

一个 `DATABASE_URL`,三种跑法 —— 同一份代码,不加任何后端:

- **本地(默认)。** `docker compose up -d` 在你机器上起 Postgres + pgvector,数据一个字节不出门。
- **自建 Postgres。** 把 `DATABASE_URL` 指向你自己的服务器。需要 `vector` 扩展;`pgroonga` 可选(中文 BM25 —— 没有则回退 `pg_trgm`)。
- **托管 Postgres(Supabase / Neon / RDS / …)。** 同一个 `DATABASE_URL`,换成托管的连接串就行。Supabase 内置 `pgvector`;引擎通过 Prisma 走标准 Postgres,不绑任何厂商 SDK。

**隐私边界**:本地模式下你的**存储**(Postgres)一个字节不出门,但 embedding 和 LLM 调用会发给你配的端点（`LLM_BASE_URL` / `EMBED_BASE_URL`）——所以被嵌入 / 被推理的记忆文本是发去那些 API 的。「数据不出门」只指存储层。想全本地,把 embedding / LLM 端点换成你自托管的即可。

## 与 AGENTS.md 配对

整个引擎——尤其是 autonomy 层——在**没有注入 persona / principles
文档时是惰性的。** 这套机制是**骨架**：retrieval、drive 数学、concern sweep、
action selection（`DO_NOTHING` 是一个可用 action，而非默认）、wake loop。**灵魂**
活在你写的一份 `AGENTS.md` 里（跨 runtime 的通用约定名,类似 Claude Code 的 `CLAUDE.md`、Cursor 的 `.cursorrules`;按你工具读的名字命名、或软链过去即可）。它有两层：

- **Epistemic 层** —— *是方法，不是 persona*：发声 concern / affection 前的四条 self-check、
  回答前的 fact-check、concern 必须有数据撑、没有 RLHF welfare reflex。这对任何
  用户都成立，所以 `npm run init` 出厂时这一层是**填好的**——它就是这个 repo 的那一条原则
  （不信任 AI，也不信任你自己，只信外在证据）落到可操作的形态。
- **Relationship 层** —— *是 persona*：称呼、register、demand stance、节奏、语言规则。
  这是你的；`npm run init` 出厂时这一层是**空白的**，零示例内容。

那一半空白是刻意的。**一个 persona 是你养出来的，不是从一张表单里填出来的。** 一个被装上去的 stance
没有 ownership：一个被配置但未被认领的 volition 是在场的，却不是自己的（Frankfurt 1971），而
AI 撰写的目标在 form 上得分更高，却表现出更低的 ownership 和 follow-through（Chi et al. 2026）。
Epistemic 那一半是例外——它是方法，不是一个要去认领的 stance。见 **[docs/AUTONOMY.md](./docs/AUTONOMY.md) §7**。

## 三个一等公民工具

| command | what |
|---|---|
| `npm run init`  | 对话式 onboarding —— 访谈你,把你自己的话变成 `persona.md` + `AGENTS.md` 关系层 + `.env` |
| `npm run eval`  | 可复现的 retrieval evaluation（hit@5/10 · MRR · nDCG@10 · set-recall@10 · expectNone 负控；写趋势 Event，`npm run eval:history` 读回） |
| `npm run scrub` | leak scanner —— 拦住任何私有残留进入 commit |

## License

AGPL-3.0-or-later。
