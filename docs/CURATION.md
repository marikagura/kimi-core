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

## 整理窗（可选的每周 pass）

可选的 `consolidate` 扩展（`KIMI_EXTENSIONS=consolidate`）是这一立场的直接延伸。每周一次，它对记忆库跑三个只读 pass——分诊（无主记忆对活跃 topic 质心）、欠账点名（某个 topic 的卷摘要落后于其后新挂的链）、聚类候选（无主池里正在成形的新线）——把结果写成一条 SYSTEM event：一份整理清单。它只算候选，从不挂链、合并或写入记忆。下一个会话读这份清单，由人来决定。pass 顺序有意为之：分诊 → 消化 → 聚类；反序会把聚类饿死。

调度默认周日 23:00（`CONSOLIDATE_CRON`，在每周 arc 之后），且不做任何 LLM 调用；也可手动 `npm run consolidate`。前缀过滤（哪些是例行层、哪些是 topic 卷）是中性英文占位，用 `CONSOLIDATE_ROUTINE_PREFIXES` / `CONSOLIDATE_ARC_PREFIXES` 指向你自己的标题约定，见 `config.example.yaml`。

## 致谢

整理窗的调度顺序（分诊 → 消化 → 聚类）参考了 [zziying/consolidation-draft](https://github.com/zziying/consolidation-draft) 公开的调度经验；未复用其代码或文字，仅致谢「反序会把聚类饿死」这一思路。
