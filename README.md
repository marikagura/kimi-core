> English: ./README.en.md

# kimi-core

一个**个人用的 agent memory OS** —— 一人对一个 AI(1v1)的 agentic 记忆 + self-drive 引擎，内置一套对抗式自审 harness。

关于架构设计请读 **[ARCHITECTURE.md](./ARCHITECTURE.md)**——下面这些都只是零件。
关于 autonomous-agency 层（cron wake → drive/concern → action selection，DO_NOTHING 是一个选项而非默认 → dispatch），
请读 **[docs/AUTONOMY.md](./docs/AUTONOMY.md)**——架构论证、完整 citations，以及诚实的断层线。
搭这套东西踩过的工程陷阱都收在 **[docs/PATTERNS.md](./docs/PATTERNS.md)**——缓存、冷启动、Prisma/pgvector、检索、agent 安全、retry、时间等十六类，无声失败和域内专有的在前、基础卫生(table-stakes)附在文末。fork 前建议通读一遍。
认知纪律（检索优先 / 不编 / 归因 / 对称验证 / concern self-check）见 **[docs/EPISTEMIC.md](./docs/EPISTEMIC.md)**——这是 AGENTS.md epistemic 层的操作手册。
想把它当一个前端的**唯一后端**（记忆 + dashboard 数据 + 状态快照）用，见 **[docs/ONE-ENGINE.md](./docs/ONE-ENGINE.md)**——配 [kimi-room](https://github.com/marikagura/kimi-room)（PWA）/ [kimi-manor](https://github.com/marikagura/kimi-manor)（桌面仪表盘），开 `KIMI_EXTENSIONS=store` 即可。

> **状态：引擎完整，有测试有文档。** hybrid retrieval、self-drive / concern、可复现 eval、对话式
> onboarding、参考投递 providers、对抗式自审 harness 都已落地（tsc + test + scrub 在 CI 里跑）。
> autonomous wake daemon 已接线、有单元测试；真正跑它要订阅 token + 两进程拓扑（见下「运行 autonomous daemon」）。

## 它是什么

- **Hybrid retrieval** —— dense(pgvector)+ lexical(BM25 / trigram)+ 时间衰减 + 重要度，四信号
  加权（entity-mention 是关键词臂的加成 + 过滤旁路，单跳；多跳 `graph_walk` 是独立工具，不进排序），
  外加一个可选的 cross-encoder rerank 阶段。
- **Active self-drive** —— Panksepp 式的情感 drives，会主动地把记忆 *surface* 出来，外加一个
  concern 引擎(open / resolved · decay · recurrence · grounding)。
- **Event sourcing + append-only + 人工 curation** —— 没有 LLM 自动 consolidation（它的 failure mode 是
  静默腐蚀）。每一条关于你的 fact 都要过你自己的手并经你确认。这是必要的周期性运维（不是可选项）——怎么做见 [docs/CURATION.md](docs/CURATION.md)。
- **可复现的 retrieval eval** —— hit@5 / hit@10 / MRR / nDCG@10 / set-recall@10，带
  hard-negative 负控(expectNone)和 reranker / 组件 A/B。按 keyword 标注（不绑 row-id，
  re-seed 库也不失效），每跑写一条趋势 Event。这些数字你可以自己重跑。
- **对抗式自审 harness** —— 用一组 agent 对准你自己的 fork 去查 leak 和 bug，
  带 *行为级* 验证。（Static inference 会系统性地 over-claim。）

## 它做什么（一个具体例子）

（下面是虚构的示例用户。）

三天前你跟它说在赶一个叫 Helios 的项目、周五 deadline。今天一次定时 wake 里，self-drive 的「陪伴」维度涨起来（距上次聊很久了），concern 引擎也标记出那个临近的 deadline——于是它 surface 出来的不是泛泛问候，是「Helios 周五就到了，昨天那版 demo 受阻于何处？」。因为它**检索**到了那条记忆，而且关心**grounding 在你真说过的话**上。

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

**model 和 provider 都不附带。** 两样都不预设：LLM 端点用 `LLM_BASE_URL` + `LLM_API_KEY`
（任何 OpenAI 兼容端点——OpenRouter / OpenAI / 本地 vLLM·Ollama 都行）+ 一个 `KIMI_MODEL`
（那个端点认的模型 id）；语义检索用 `EMBED_BASE_URL` + `EMBED_API_KEY` + `EMBED_MODEL`；跑 daemon
才需要 `DAEMON_MODEL`（裸 Claude id）。`npm run init` 会问你；没设就 fail-closed、报一条清楚的错，
而不是悄悄拿一个你没选过的端点或模型去跑。

## 运行 autonomous daemon（可选）

引擎是两个进程：**gateway**（HTTP MCP 服务，`npm run dev` 起在 :3001，记忆 / 工具都从这里走）+ 一个 **wake daemon**（按 cron 醒来、读 drive / concern、决定做什么）。daemon 是可选的——不运行它，引擎仍是一个完整的记忆 + 检索后端。

```bash
# 终端 1：gateway（必须先起）
npm run dev
# 终端 2：daemon
cd apps/gateway
npm run daemon          # 按 cron 持续跑（生产里用 pm2 等守护进程）
npm run daemon:wake     # 只立刻跑一次 wake —— 用来验证
```

**作者的daemon 用 Claude Agent SDK**，所以它需要一个 Claude(Anthropic)订阅 token：`claude setup-token` 生成，填进 `.env` 的 `CLAUDE_CODE_OAUTH_TOKEN`。引擎其余部分是 provider 无关的（LLM 和 embedding 都走你自己配的兼容端点 `LLM_BASE_URL` / `EMBED_BASE_URL`）——**只有这条自主 wake 循环绑 Claude**；用别的 agent runtime 替换 daemon 这一层即可，引擎本身无需改动。

> 诚实交代：作者端到端验证过引擎 + eval；完整的 daemon wake 循环（接线 / model / 传输都已对齐）请你用自己的 token 在自己机器上确认一次。

## 运行 intel（digests + concern sweep · 可选）

引擎还带一个 **intel 进程**（`apps/gateway/src/intel.ts`）——按 cron 把原始对话整理成 dialogue digests，并每日跑一次 concern 的 decay→sweep→derive（自情绪扫描）。它**不绑 Claude**（走你配的 `KIMI_MODEL`，可选 `INTEL_MODEL` / `INTEL_DIGEST_MODEL` / `INTEL_SWEEP_MODEL` 角色覆盖），所以比 daemon 更易跑：

```bash
cd apps/gateway
npm run intel           # 自带 cron 自调度（daily runAll + 每小时 digest tick）
```

不跑它，记忆仍可检索；只是没有自动 digest（喂 reentry 的「近期对话摘要」）和每日 concern sweep。`extractFromChat` 是范例抽取器——克隆它、换数据源即可从 email / dream / telegram 等任意来源抽 memory candidate（各来源是部署者自己的，故只附通用对话版）。

## 存储

一个 `DATABASE_URL`，三种跑法 —— 同一份代码，不加任何后端：

- **本地（默认）。** `docker compose up -d` 在你机器上起 Postgres + pgvector，数据一个字节都不离开本机。
- **自建 Postgres。** 把 `DATABASE_URL` 指向你自己的服务器。需要 `vector` 扩展；`pgroonga` 可选（中文 BM25 —— 没有则回退 `pg_trgm`）。
- **托管 Postgres(Supabase / Neon / RDS / …)。** 同一个 `DATABASE_URL`，换成托管的连接串就行。Supabase 内置 `pgvector`；引擎通过 Prisma 走标准 Postgres，不绑任何厂商 SDK。

**隐私边界**：本地模式下你的**存储**(Postgres)一个字节不出门，但 embedding 和 LLM 调用会发给你配的端点(`LLM_BASE_URL` / `EMBED_BASE_URL`)——所以被嵌入 / 被推理的记忆文本是发去那些 API 的。「数据不离开本机」仅指存储层。若需完全本地化，将 embedding / LLM 端点替换为自托管端点即可。

## 与 AGENTS.md 配对

整个引擎——尤其是 autonomy 层——在**没有注入 persona / principles
文档时是惰性的。** 这套机制是**骨架**：retrieval、drive 数学、concern sweep、
action selection（`DO_NOTHING` 是一个可用 action，而非默认）、wake loop。**灵魂**
活在你写的一份 `AGENTS.md` 里（跨 runtime 的通用约定名，类似 Claude Code 的 `CLAUDE.md`、Cursor 的 `.cursorrules`；按你工具读的名字命名、或软链过去即可）。它有两层：

- **Epistemic 层** —— *是方法，不是 persona*：检索优先、不生成记忆、归因必查、对称验证（人类输入同样不豁免）、concern self-check、不做 RLHF welfare reflex。这对任何
  用户都成立，所以 `npm run init` 出厂时这一层是**填好的**——它就是这个 repo 的那一条原则
  （不信任 AI，也不信任你自己，只信外在证据）落到可操作的形态。具体操作规则见 **[docs/EPISTEMIC.md](./docs/EPISTEMIC.md)**。
- **Relationship 层** —— *是 persona*：称呼、register、demand stance、节奏、语言规则。
  这是你的；`npm run init` 出厂时这一层是**空白的**，零示例内容。

那一半空白是刻意的。**一个 persona 是你养出来的，不是从一张表单里填出来的。** 一个被装上去的 stance
没有 ownership：一个被配置但未被认领的 volition 是在场的，却不是自己的(Frankfurt 1971)，而
AI 撰写的目标在 form 上得分更高，却表现出更低的 ownership 和 follow-through(Chi et al. 2026)。
Epistemic 那一半是例外——它是方法，不是一个要去认领的 stance。见 **[docs/AUTONOMY.md](./docs/AUTONOMY.md) §7**。

## 三个一等公民工具

| command | what |
|---|---|
| `npm run init`  | 对话式 onboarding —— 访谈你，把你自己的话变成 `persona.md` + `AGENTS.md` 关系层 + `.env` |
| `npm run eval`  | 可复现的 retrieval evaluation（hit@5/10 · MRR · nDCG@10 · set-recall@10 · expectNone 负控；写趋势 Event，`npm run eval:history` 读回） |
| `npm run scrub` | leak scanner —— 拦住任何私有残留进入 commit |

## 会话生命周期工具：reentry / reentry_delta / closeout

agent 在一段对话里按这三个 MCP 工具走完整个生命周期：

- **`reentry`** —— 新窗口开头调一次。把 profile、active states、topics、anchors(CORE / BOUNDARY / PREFERENCE)、近期 episodes、digests、近期 events 一次性载入成冷启动上下文。可传 `tag`（窗口标识，建议 `cc-YYMMDDHHMM`）落一个 boot 锚点，这个窗口之后的 `reentry_delta` 都锚到它。**由会行动的那个 agent 自己调，不要转交给 subagent 代读**——转述只回一个摘要，而让 agent 真正进入状态的 nuance 过一道摘要就丢了（展开见 [PATTERNS §2](./docs/PATTERNS.md)）。
- **`reentry_delta`** —— 会话中途调，只取自上次 reentry / delta 以来**新增**的（按 `tag` 沿锚链），比整段 reentry 便宜。
- **`closeout`** —— 窗口结束前调一次。把这段对话存成一条 EPISODE（只写 arc，不复述已落表的事实）+ 一条 self-score（valence / arousal，负向且复发可带 `concernKey`）+ keyMemories / stateUpdates / observations / pendingItems，建相似边，落一个会话结束标记。

这三个名字是作者 canon 的延续。如果你有和 AI 约定好的词，请**在代码里**自行修改：`tools.ts` 的工具名 + `AGENTS.md`、agent prompt 里所有引用处——一起改，否则 agent 按旧名将无法调用。

## 工具全集速查（MCP 工具）

`registerAllTools` 默认挂这 6 组、共 28 个工具，agent 在对话里调（上面那张表是 `npm run` CLI 命令，两类不同）。

**记忆 · memory（7）**

- `memory_search` —— 混合检索：语义(pgvector)+ ILIKE 子串(CJK 友好)+ pg_trgm 模糊(Latin 友好)+ entity-mention 边，统一排序不短路。`scope=full` 扩到 observation/profile/RESTRICTED 私池，`rerank=true` 走本地 cross-encoder 重排（更慢，给 oblique / 语义 / 全局回忆用）。
- `memory_search_safe` —— 给协作的外部 agent 的非敏感检索：server 硬锁 `scope=default`、拒 RESTRICTED/SELF_SCORE、每条过一遍公开内容谓词。
- `memory_write` —— 写一条记忆，带情感坐标(valence/arousal)+ experiencer(USER/SELF/SHARED)。
- `memory_read` —— 读近期记忆或某类型全部（RESTRICTED 默认排除）。
- `memory_close` —— 软删除(isActive=false)。
- `memory_reopen` —— 把被 selfSweep 误判 RESOLVED/SUPPRESSED 的 SELF_CONCERN 重新打开为 OPEN。
- `graph_walk` —— 沿知识图 `links` 边多跳(1–3) BFS 游走，找一条记忆/实体/话题连着什么。

**状态 / 话题 / 事件 · state（8）**

- `state_set` / `state_get` / `state_read` / `state_close` —— active state 的写 / 取全文 / 读 / 关（`summary` 必填 ≥20 字，reentry 只读 summary 防 token 爆）。
- `topic_create` / `topic_list` —— 话题建 / 列。
- `event_log` / `event_read` —— 事件记 / 读（按 type·source 过滤，默认近 24h）。

**实体（知识图 V2）· entity（4）**

- `entity_write` —— upsert 实体（PERSON / TOOL / PLATFORM / PROJECT / CONCEPT）。
- `entity_search` / `entity_list` —— 按名·摘要搜 / 按类型列。
- `entity_close` —— 停用(status=INACTIVE，不删，历史引用仍可查)。

**画像 / register / 观察 · profile（6）**

- `profile_read` / `profile_set` —— core profile 读 / 写。
- `private_read` —— 读 `private_*` 受限画像层。
- `register_read` / `register_set` —— 说话风格预设(register profile)读 / 写。
- `observation_write` —— 写一条 observation（被动观察记录）。

**会话生命周期（3）** —— 详见上一节：`reentry` / `reentry_delta` / `closeout`。

**可选扩展 · paper（2，不在默认 registry）** —— 领域工具的扩展范例，演示怎么挂一个独立 store：`paper_write` / `paper_search`（学术知识点写入 / 检索 `paper_notes`，与 memory 分离）。

**可选扩展 · store** —— 给前端 surface（kimi-room / kimi-manor）的结构化数据 store：`store`（`store_rows` 上的 CRUD —— 日历 / 睡眠 / 纪念等，按 `collection` 分）+ `state_snapshot`（仪表盘只读快照）。返回 JSON 而非 agent-text，与 memory 引擎分离，让一个前端能把同一个 core 当唯一后端用。

扩展默认全关。用 `KIMI_EXTENSIONS=store`（逗号分隔，如 `store,travel`）按名启用 —— 同一个 env 既管 tool 扩展（`store` / `paper`）也管 daemon 扩展（`travel` / `demo-feed`）。怎么写扩展、外部信号怎么自动流进来（`POST /events` / `demo-feed`），见 **[docs/EXTENSIONS.md](./docs/EXTENSIONS.md)**。

## 可配置项

引擎的几个旋钮都走 env，默认安全（fail-closed / 全关）：

- **drive 维度（`DRIVE_DIMS`）** —— drive roster 是可自定义的：一个 JSON 数组列你自己的维度；不设则用代码里的范例 `DEFAULT_DRIVE_DIMS`。引擎不读 YAML，维度形状见 **[docs/DRIVES.md](./docs/DRIVES.md)**。连「它想要什么」都是你定义的，不是写死四个。
- **HITL 旋钮（`DAEMON_AUTONOMY_MODE`）** —— `propose`（默认，human-in-the-loop：对外动作只 staged、不直接发）/ `auto`（直接 commit）。`DAEMON_WAKE_CRON` 调唤醒节奏。
- **投递 / 搜索 providers** —— `NOTIFIER`：`none` / `console` / `webhook`（+ `NOTIFIER_WEBHOOK_URL`，daemon 对外推送）；`SEARCH_PROVIDER`：`none` / `http`（好奇心 web search）。env 驱动、默认全关，参考实现在 `lib/providers.ts`。
- **rerank（`RERANK_PROVIDER`）** —— `none` / `local` / `cohere` / `jina` / `voyage`；检索末端可选的 cross-encoder 重排阶段。

## 两条容易被略过的姿态

- **`DO_NOTHING` 是平权的一个 action，不是兜底默认。** 唤醒后的 action selection 里，「这次不出声」和「发一条」同权——弃权本身就是能动性的一种表达，不是每次醒来都必须打扰你。完整论证见 **[docs/AUTONOMY.md](./docs/AUTONOMY.md) §2**。
- **行为级验证 > 静态推断。** 自审 harness 用一组 agent 真去触发行为来查 leak / bug，而不是静态读代码推断「应该没问题」——因为静态推断会系统性 over-claim。见 **[docs/SELF-AUDIT.md](./docs/SELF-AUDIT.md)**。

## License

AGPL-3.0-or-later。
