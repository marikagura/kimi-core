# 上下文层与注入

kimi-core 把「查什么 + 怎么分层」定义一次,放在 `@kimi/context-core`(`packages/context-core/src/index.ts`)。
每个 surface —— 对话端(tg)、语音(voice)、网页 chatroom、agent harness(cc)—— 都是同一个 agent 的
不同输出,不是各自独立的系统。所以「查哪些表、怎么分层」的逻辑只写一份;各输出
(`turn-context.ts` / `tools-reentry.ts` 等)只是薄薄的格式层。

本文说明:有哪几层、每层从哪来、每个 surface 怎么注入。不含任何部署方的具体内容 —— 引擎只定义
结构,内容由你自己填。

## 层一览

每层独立加载,任何输出只组合它需要的切片。

| 层 | 来源 | 是什么 |
|---|---|---|
| profile | `coreProfile` | 常驻身份 / 设定档(按 importance 排序) |
| register | `registerProfile` | 语气 / 风格档(没有就用中性默认值) |
| anchors | `memory`(CORE / BOUNDARY / PREFERENCE) | 长期规则与偏好,全文常驻 |
| states | `activeState` | 当前进行中的状态(注入摘要,全文按需 `state_get`) |
| observations | `observation` | 关于 user / assistant 的结构化观察 |
| episodes | `memory`(EPISODE) | 近期重要的叙事记忆(按 importance 取前若干) |
| topics | `topic` | 活跃话题 |
| digests | `memory` | 对话摘要 —— 把过往对话压成的一条条摘要 |
| events | `event` | 近期非对话信号(git commit / app 打开 / 日历等) |
| entities | `entity` | 人物卡与项目卡 |
| persona | 外部 `persona.md` | 称呼 / register / 原则;引擎不带,从你写的文件注入 |
| merged-chat | `event`(CHAT) | 跨 surface 合并的一条对话时间线(见下) |

> 内容自带:profile / 记忆 / persona / register 全部由部署方填。引擎只定义层与注入,出厂不带内容。

## 怎么注入

### 冷启动 —— `reentry` 工具

新窗口开始时调一次 `reentry`,把这些层按固定顺序拼成一块冷启动上下文:
Profile → Active States → Active Topics → Anchors(CORE / BOUNDARY / PREFERENCE)→ Observations →
Recent Episodes → 对话摘要 → 最近原文对话(raw · 跨 surface 合并)→ Recent Events。其中「最近原文对话」
让新窗口直接接上当前对话(不只看摘要),默认不过滤;如需可在此加 denylist 把某些行挡在外面。
`reentry_delta` 取自这个窗口上一个锚点以来的增量。

### 每轮 —— `turn-context`

每条消息生成回复时,把合并对话时间线 + 需要的层拼进 prompt。

### merged-chat:一个 agent,多处对话

CHAT event 按 `createdAt`(服务端单一时钟)合并成一条时间线,让多个 surface 读到同一段对话 ——
你在一处说的话,另一处接得上。合并由 `loadMergedChat` 在服务端完成(拼 prompt 用)。前端要把这条
时间线读回来渲染,需要一个把它读回的工具 / 端点(见 `docs/EXTENSIONS.md` 的摄入段)。冷启动(reentry)
也会注入最近一段原文对话,让新窗口直接接上当前对话(默认不过滤,如需可加 denylist)。

### 精简 vs 全文 —— `canMcp`

能自查的 surface(chatroom 可经 MCP 自己回查)某些层只注入精简版(标题 / 索引),需要时再查;
不能回查的 surface(推送类:tg / voice)注入全文,因为推送当下补不回来。这是 `ContextOpts.canMcp`
给格式层的信号。

### 按 surface 取舍

surface 决定哪些层组合进它的输出。有些层按 surface 选择性注入(各 loader 自带规则:不适用某
surface 时返回 null、跳过)。

### 冷启动排除钩子

`lib/reentry-filter.ts` 是一个出厂为空的钩子:部署方可以配置「哪些行不进冷启动」(按标题 / 前缀 /
内容规则)。默认不排除 —— 引擎开箱即用,不带任何 denylist。

## 自己定义什么

引擎做到的是「有哪几层、怎么注入」这套机制;内容和分类规则由你填:

- 各层的内容(profile / 记忆 / observation / topic / entity)。
- `persona.md`(称呼 / register / 原则)。
- 选配:冷启动排除规则(`reentry-filter.ts`)、anchor id / 前缀方案。
