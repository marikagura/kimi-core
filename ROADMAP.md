> English: ./ROADMAP.en.md

# Roadmap

如实命名做到了什么、还差什么，而不是暗示。

## 已经在 core 里（落地、有测试、有文档）

- **Hybrid retrieval** —— dense（pgvector）+ lexical（trigram / 可选 BM25）+ entity graph walk 四信号加权 + 可选 cross-encoder rerank（带隐私门控）。
- **self-drive + concern 引擎** —— 四种 SEEKING 形态、**config 驱动的维度**（你自己定义，见 [docs/DRIVES.md](./docs/DRIVES.md)）、concern 的 open / decay / recurrence / grounding。
- **可复现 eval** —— hit@5 / hit@10 · MRR · nDCG@10 · set-recall@10 · expectNone 负控 · 组件 / rerank A/B · 每跑写趋势 Event（`npm run eval` / `npm run eval:history`）。
- **autonomous wake daemon** —— cron wake → drive / concern / persona → action selection（DO_NOTHING 是一个选项）→ dispatch，带 HITL propose / auto 旋钮（`daemon.ts` + `intel.ts`，论证见 [docs/AUTONOMY.md](./docs/AUTONOMY.md)）。
- **对抗式自审 harness** —— `npm run scrub` 机械去敏闸 + [docs/SELF-AUDIT.md](./docs/SELF-AUDIT.md) 行为级审计。
- event-sourcing + append-only + 人工 curation；CI（tsc + test + scrub）。

## 还差什么（刻意尚未纳入 / 未完成）

- **SQLite 存储后端。** 现在跑在 Postgres + pgvector 上（一个 `DATABASE_URL`，本地 Docker 或任意远端）。一层 repository 抽象 + SQLite + sqlite-vec backend，给一个零依赖的 "lite" 模式（无 Docker、无 server）。reranker 已是插件形态；storage 还不是——下一个该插件化的边界。
- **规模化检索索引。** 当前检索每查询一次全表打分（单用户体量足够，`retrieval.ts` 里写明）。过约 1 万行该切到候选池 CTE（HNSW + trigram GIN）再打分——ANN 路径还没接。
- **投递层（seam 在、实现未发）。** wake daemon 有可插拔 Notifier seam、WEBSEARCH 有 pluggable search provider（默认 no-op）、EXPLORE 内容留空——seam 都在，但 core 不发任何具体投递 / 搜索实现（push / email / 搜索后端按你的部署接）。
- **对话式 onboarding。** `npm run init` 现在是 CLI 问卷；chat 风格的 persona 构建器（persona 真正被养成的方式）是 v2。

## v2

- 对话式 persona 构建器，替代 CLI 问卷。
- 可插拔 storage（含 SQLite lite 模式）。
- 规模化检索（ANN 候选池），并把跨版本的 eval 数字发布出来。
- 至少各一个开箱即用的参考 Notifier / search provider 实现。
