# 人工 curation

本引擎是 append-only 的，且**从不自动 consolidate 记忆**（见 ARCHITECTURE / EPISTEMIC：既不信 AI 也不信自己，只信外部证据）。这个设计有代价：**记忆库会一直增长，直到你手动 curate。** 这是有意的——每一条关于你的事实都要经你确认——但也意味着 curation 是一个真实、周期性的运维操作，不是可选项。

## curate 什么

- **高 importance 的 core**（`importance` 4-5）：身份 / 承诺 / 边界类记忆。定期复核——合并重复、关掉被取代的、修正漂移。它们在每次上下文拼装里权重最大，过时的代价也最大。
- **重复 / 近重复**：append-only 意味着同一条事实可能落两次。
- **过时 / 被取代**：事实变了，关掉旧的。
- **已实际解决却没关掉的 OPEN concern**。

## 怎么做（不需要 dashboard）

引擎自带 MCP 工具，任何 MCP 客户端（或你自建的 UI）都能驱动：

- `memory_read`（按 importance 倒序）/ `memory_search` —— 看库里有什么。
- `memory_close`（按 id，或 titleMatch）—— 软删除（`isActive=false`；不硬删，可恢复）。
- `memory_reopen` —— 把误关的 concern 重新打开。
- `graph_walk` —— 关掉一条记忆前，先看它连着什么。

也可以直接查库（Postgres，`memories` 表）。本仓自带的后台 UI 是另一个项目；**这些工具才是可移植的接口。**

## 什么时候（引擎会提醒你）

每日 intel run 会输出一行 `curation:`（active 总数、高 importance 池、open concern 数），并在高 importance 池超过阈值（`CURATION_REVIEW_THRESHOLD`，默认 30）时打 flag。把它接到你的 notifier，或直接读 intel summary。

重点：你不用记着 curate——引擎会提醒你。
