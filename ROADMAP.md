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

## 可选(非核心,有需要再加)

- **更多投递 / 搜索后端预设。** 参考实现已发(webhook notifier、http search provider);更多开箱即用的具体后端(Slack / Discord / ntfy 预设、特定 search API 适配)欢迎,但不是必需。EXPLORE 的建议内容按设计留空(persona 层)。
- **发布跨版本的 eval 数字。** 把 `retrieval_eval` 的趋势随版本贴出来,纯展示用,不影响引擎。

