> English: ./README.en.md

# kimi-core

一个**个人用的 agent memory OS** —— 一人对一个 AI（1v1）的 agentic 记忆 + self-drive 引擎，内置一套对抗式自审 harness。

关于架构设计请读 **[ARCHITECTURE.md](./ARCHITECTURE.md)**——下面这些都只是零件。
关于 autonomous-agency 层（cron wake → drive/concern → action selection，DO_NOTHING 是一个选项而非默认 → dispatch），
请读 **[docs/AUTONOMY.md](./docs/AUTONOMY.md)**——架构论证、完整 citations，以及诚实的断层线。

> **状态：引擎可用、在打磨。** Core 引擎——hybrid retrieval、self-drive / concern、可复现 eval、
> 自审 harness、autonomous wake daemon——已落地，有测试有文档。仍在打磨的是 storage 可移植性
> （SQLite lite 模式）、规模化检索索引、对话式 onboarding、以及投递层（详见 [ROADMAP](./ROADMAP.md)）。
> 这是一个真实的、进行中的移植——不是一次性的代码倾倒。

## 它是什么

- **Hybrid retrieval** —— dense（pgvector）+ lexical（BM25 / trigram）+ entity graph walk，四信号
  加权，外加一个可选的 cross-encoder rerank 阶段。
- **Active self-drive** —— Panksepp 式的情感 drives，会主动地把记忆 *surface* 出来，外加一个
  concern 引擎（open / resolved · decay · recurrence · grounding）。不是按 importance 排序。
- **Event sourcing + append-only + 人工 curation** —— 没有 LLM 自动 consolidation（它的 failure mode 是
  静默腐蚀）。每一条关于你的 fact 都要过你自己的手并经你确认。
- **可复现的 retrieval eval** —— hit@5 / hit@10 / MRR / nDCG@10 / set-recall@10，带
  hard-negative 负控（expectNone）和 reranker / 组件 A/B。按 keyword 标注（不绑 row-id，
  re-seed 库也不失效），每跑写一条趋势 Event。是你能重跑的数字，不是 README 里的一句声明。
- **对抗式自审 harness** —— 把一支 agent 舰队对准你自己的 fork 去猎 leak 和 bug，
  带 *行为级* 验证。（Static inference 会系统性地 over-claim——这是吃过亏学来的。）

## 快速开始（本地）

```bash
npm install
docker compose up -d          # local Postgres + pgvector — or point DATABASE_URL at your own DB
cp .env.example .env          # fill DATABASE_URL + OPENAI_API_KEY + OPENROUTER_API_KEY + KIMI_API_KEY
npm run db:migrate:deploy
npm run init                  # onboarding — builds your config.yaml + persona.md
npm run dev
```

**这个 repo 里不附带任何 persona。** 没有内建的人格，没有示例关系，没有词表。
你自己带——`npm run init` 会带你一步步把它建起来。引擎刻意空着出厂；
这份空白正是最强形式的去标识化。

## 存储

一个 `DATABASE_URL`,三种跑法 —— 同一份代码,不加任何后端:

- **本地(默认)。** `docker compose up -d` 在你机器上起 Postgres + pgvector,数据一个字节不出门。
- **自建 Postgres。** 把 `DATABASE_URL` 指向你自己的服务器。需要 `vector` 扩展;`pgroonga` 可选(中文 BM25 —— 没有则回退 `pg_trgm`)。
- **托管 Postgres(Supabase / Neon / RDS / …)。** 同一个 `DATABASE_URL`,换成托管的连接串就行。Supabase 内置 `pgvector`;引擎通过 Prisma 走标准 Postgres,不绑任何厂商 SDK。

上面三种(含 Supabase)现在都能用。**唯一**还没做的是零依赖的 SQLite "lite" 后端(不用 Docker、不用 server)——它在 [ROADMAP](./ROADMAP.md) 上。

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
| `npm run init`  | onboarding wizard —— 把几个回答变成 `config.yaml` + `persona.md` |
| `npm run eval`  | 可复现的 retrieval evaluation（hit@5/10 · MRR · nDCG@10 · set-recall@10 · expectNone 负控；写趋势 Event，`npm run eval:history` 读回） |
| `npm run scrub` | leak scanner —— 拦住任何私有残留进入 commit |

## License

AGPL-3.0-or-later。
