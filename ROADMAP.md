> English: ./ROADMAP.en.md

# Roadmap

这是一个**个人单用户(1v1)的 agent memory OS** —— 不追多用户 / production 规模。

## 已经在 core 里(落地、有测试、有文档)

- **Hybrid retrieval** —— dense(pgvector)+ lexical(trigram / 可选 BM25)+ entity graph walk 四信号加权 + 可选 cross-encoder rerank(带隐私门控)。
- **self-drive + concern 引擎** —— 四种 SEEKING 形态、**config 驱动的维度**(你自己定义,见 [docs/DRIVES.md](./docs/DRIVES.md))、concern 的 open / decay / recurrence / grounding。
- **可复现 eval** —— hit@5 / hit@10 · MRR · nDCG@10 · set-recall@10 · expectNone 负控 · 组件 / rerank A/B · 每跑写趋势 Event(`npm run eval` / `npm run eval:history`)。
- **autonomous wake daemon** —— cron wake → drive / concern / persona → action selection(DO_NOTHING 是一个选项)→ dispatch,带 HITL propose / auto 旋钮(`daemon.ts` + `intel.ts`,论证见 [docs/AUTONOMY.md](./docs/AUTONOMY.md))。
- **对话式 onboarding** —— `npm run init` 是一段对话:访谈你,用你自己的话长出 persona / AGENTS.md 的关系层(从不替你写);有 key 时加自适应追问、无 key 是引导式对话(`scripts/init.ts` + `persona-build.ts`)。
- **对抗式自审 harness** —— `npm run scrub` 机械去敏闸 + [docs/SELF-AUDIT.md](./docs/SELF-AUDIT.md) 行为级审计。
- **参考投递 providers** —— 可配置的 Notifier(console / webhook)+ search provider(http),env 驱动、默认关(`lib/providers.ts`,wire 进 daemon)。
- event-sourcing + append-only + 人工 curation;CI(tsc + test + scrub)。

## 还差什么(未完成)

- **SQLite lite 后端。** 现在跑在 Postgres + pgvector 上(一个 `DATABASE_URL`)。一层 storage / 检索后端抽象 + SQLite(sqlite-vec 向量 + FTS5 词法)给一个零依赖的 "lite" 模式:`npm install` 就能跑,不用 Docker、不用 server —— 正合单用户个人场景。检索层的原生 SQL(pgvector `<=>`、pg_trgm、pgroonga)绑死 Postgres,SQLite 等于第二套检索实现,是个多回合工程。**这是下一步的重点。**
- **更多投递 / 搜索集成。** 参考实现已发(webhook notifier、http search provider);更多开箱即用的具体后端(Slack / Discord / ntfy 预设、特定 search API 适配)仍欢迎。EXPLORE 的建议内容按设计留空(persona 层)。


## v2(下一步)

- **SQLite lite** —— 零依赖个人模式(下一步的重点,多回合)。
- 把跨版本的 eval 数字发布出来(回归趋势)。
- 更多开箱即用的投递 / 搜索后端预设。
