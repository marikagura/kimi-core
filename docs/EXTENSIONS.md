> English: ./EXTENSIONS.en.md

# 扩展与摄入（Extensions & Ingest）

core 默认是一个记忆引擎，**不带任何扩展**。需要的能力按名启用：

```bash
KIMI_EXTENSIONS=store,travel,demo-feed
```

留空 / 不设 = 全关，引擎与出厂一致。本文前半讲怎么写一个扩展、它怎么接进来；后半（§5）讲外部信号怎么自动流进来，让前端从“被布置好的房间”变成“自己在动的房间”。

---

## 1. 一个 registry，两个 seam

一个扩展是一个 `KimiExtension`（`apps/gateway/src/lib/extensions.ts`）：

```ts
export interface KimiExtension {
  name: string;
  registerTools?: (server: McpServer) => void; // MCP-server 端
  registerActions?: () => void;                // daemon 端
}
```

两个 seam 在**两个不同的进程上下文**里生效：

| seam | 在哪运行 | 谁调用 | 用来做 |
|------|----------|--------|--------|
| `registerTools(server)` | MCP server（`index.ts` / `http-server.ts`） | `registerAllTools(server)` 之后 `loadExtensions(server, enabledExtensions())` | 在核心工具旁边挂 MCP 工具 |
| `registerActions()` | daemon（`daemon.ts`） | 启动时 `loadExtensionActions(enabledExtensions())` | 注册 agency action（`registerAction`）和/或起定时任务（`node-cron`） |

一个扩展可以只实现其一、两个都实现、或都不实现。**默认什么都不加载。**

启用由 env 驱动：`apps/gateway/src/lib/enabled-extensions.ts` 里的 `REGISTRY` 把名字映射到扩展对象，`KIMI_EXTENSIONS` 按名挑选。要加一个新扩展，就在 `REGISTRY` 里登记一行。

---

## 2. 写一个 tool 扩展

以 `store` / `paper` 为例（`apps/gateway/src/extensions/paper/`）。一个 tool 扩展在 `registerTools` 里调 `server.tool(...)`：

```ts
import type { KimiExtension } from "../../lib/extensions.js";

export const myExtension: KimiExtension = {
  name: "my-ext",
  registerTools(server) {
    server.tool("my_tool", "what it does", { /* zod schema */ }, async (args) => {
      // ... 读写你自己的表，返回 { content: [{ type: "text", text: JSON.stringify(result) }] }
    });
  },
};
```

然后在 `enabled-extensions.ts` 的 `REGISTRY` 加 `"my-ext": myExtension`，部署时 `KIMI_EXTENSIONS=my-ext` 即开。

---

## 3. 写一个 daemon 扩展（action / 定时）

daemon 端有两种典型形态，都走 `registerActions`：

**(a) agency action** —— 让 wake 循环可以*选择*的一个动作。以 `travel` 为例（`apps/gateway/src/extensions/travel/action.ts`）：定义一个 `ActionHandler`，在 `registerActions` 里 `registerAction(handler)`。动作选择与分发见 `docs/AUTONOMY.md` 描述的 wake → select → dispatch 环。

**(b) 定时任务** —— 一个按自己时钟跑的后台 job。以 `demo-feed` 为例（`apps/gateway/src/extensions/demo-feed/feed.ts`）：在 `registerActions` 里 `cron.schedule(...)`，每个 tick 写自己的表。

```ts
import cron from "node-cron";
import type { KimiExtension } from "../../lib/extensions.js";

function registerMyFeed(): void {
  cron.schedule(process.env.MY_CRON || "*/5 * * * *", () => {
    myTick().catch((e) => console.error("[my-feed] tick error:", e?.message || e));
  });
}

export const myFeedExtension: KimiExtension = {
  name: "my-feed",
  registerActions: registerMyFeed,
};
```

同样在 `REGISTRY` 登记，`KIMI_EXTENSIONS=my-feed` 启用。daemon 启动时会替你调 `registerActions()`。

---

## 4. 内置示例一览

| 名字 | seam | 文件 | 是什么 |
|------|------|------|--------|
| `store` | tools | `extensions/store/` | 前端 dashboard 数据的结构化 CRUD（`store` / `state_snapshot`） |
| `paper` | tools + actions | `extensions/paper/` | 学术笔记 `paper_search` / `paper_write` / `paper_list` + 可选 `PAPER_LOOP_CRON` 定时 digest（端到端见 §6） |
| `travel` | actions | `extensions/travel/action.ts` | 一个 agency action 示例：把 wake 这 tick 生成的内容记成 EPISODE |
| `demo-feed` | actions | `extensions/demo-feed/feed.ts` | 一个定时任务示例：模拟外部信号源喂表，让 room 自己动起来（见 §5） |
| `weekly-arc` | actions | `extensions/weekly-arc/` | 一个定时任务示例：把一周的 memory（episodes / 自评曲线 / 状态变化 / dreams）卷成一段叙事 arc，写回成一条 SHARED EPISODE（`WEEKLY_ARC_CRON`；arc 的声音 = 你的 persona（`persona.md`）+ 一个 flat demo scaffold——出厂中性、不带任何人的口吻，要填 persona + 自己改才成你的） |

写完一个扩展，记得它默认关着：不进 `KIMI_EXTENSIONS` 就不加载，核心引擎一行不变。

---

## 5. 摄入（Ingest）—— 外部信号怎么进来

dashboard 之所以“活”，不是因为有人手动填，而是因为外部信号**持续地、自动地**流进两张表，再被前端读出来：

- **`events`** —— 事件溯源脊柱：一条信号一行（开了个 app、记了条 note、收到封要紧的邮件……）。
- **`pwa_kv`** —— 前端 KV 状态桥：`namespace` / `key` / `payload`，给前端按需读（如日历）。

core 给的是一个**平台中立**的摄入端点 + 一个**可跑的模拟**（就是上面的 `demo-feed` 扩展）；至于信号从哪来（手机、日历、邮箱），是**可替换的 recipe**，不是必需。

### 5.1 数据流

```
  [任意客户端]                         ┌─────────── core ───────────┐
  手机快捷指令 / Tasker / webhook       │                            │
  / cron / curl ──── POST /events ───▶ │  events (脊柱)             │
                                       │                            │      store /
  你的日历 ──── 定时同步 ──────────────▶ │  pwa_kv (前端 KV)   ──────▶ │  state_snapshot ──▶ room dashboard
                                       │                            │      (MCP 工具)
  你的邮箱 ──── 定时拉取 ──────────────▶ │  events / store_rows       │
                                       └────────────────────────────┘
```

读出端（`store` / `state_snapshot` 工具）见 `docs/ONE-ENGINE.md`。

### 5.2 通用端点 `POST /events`

任何能发 HTTP 的东西都能喂它。走全局 Bearer 鉴权，落一行 `events`：

```bash
curl -X POST "$KIMI_URL/events" \
  -H "Authorization: Bearer $KIMI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"eventType":"APP_OPEN","value":"opened the reader","source":"my-phone"}'
# → {"ok":true,"id":"…","eventType":"APP_OPEN","at":"…"}
```

只接受“外部信号”这几类：`APP_OPEN` / `MANUAL_NOTE` / `SYSTEM`（其余是引擎内部事件，不开放摄入）。`source` 随你标。curl 能跑，就什么客户端都能跑。

### 5.3 对话摄入 `POST /chat`（与 `/events` 分开）

对话不走 `/events`（那里 value 是裸字符串、不进合并时间线 / digest）。逐条发一条消息，后端组装成合规的 CHAT event（`{role,text}` JSON）、默认落主对话 source，于是被跨面合并时间线（`loadMergedChat`）和 digest 一起覆盖：

```bash
curl -X POST "$KIMI_URL/chat" \
  -H "Authorization: Bearer $KIMI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"role":"user","text":"在火山口拍到云海了","source":"my-phone"}'
# → {"ok":true,"id":"…","at":"…"}
```

逐条发，不是每轮 batch：前端发送时发用户那条、本地生成完发助手那条；`source` 区分多端、统一被合并读。MCP-native 前端（如 kimi-room）走同一条 `/mcp`：`chat_write` 追加、`chat_read` 把合并时间线读回来渲染（另一台设备写的也读得到）。多线程：写时带 `threadId` 把消息归到一条对话线；`chat_read` 给 `threadId` 只读那条（不给 = 全量合并）；`chat_threads` 列出所有线程（跨设备：别处建的线也列得到）。`chat_delete` 按 `id`（`chat_read`/`chat_write` 返回的）删一条 —— 唯一的删除口，专给前端「重试」用：把要替换掉的旧回复删掉，免得它残留在其他设备的时间线、或被总结进 digest。只动这一条 CHAT raw event，已经写成的 digest 记忆不碰；没有按线程 / 批量删。

### 5.4 看它自己动起来：`demo-feed`

不想接任何真实源，也能现场演示。`demo-feed` 扩展（`extensions/demo-feed/feed.ts`）按定时把**虚构**信号写进 `events` 脊柱 + room 渲染的 collection（calendar / keepsake / chat）：

```bash
# 1) core 开 store + demo-feed
KIMI_EXTENSIONS=store,demo-feed   # 可选 DEMO_FEED_CRON，默认每 2 分钟
# 2) room 指向这个 core
NEXT_PUBLIC_KIMI_BACKEND=core
NEXT_PUBLIC_KIMI_ADAPTER=core
```

然后打开 room：日历 / keepsake / 聊天会**自己冒出新条目**，没人手动。内容全是虚构示例（明确标 `虚构 / fictional`）。这就是上面那套流转的可跑缩影 —— 真实的源喂的是同样的表，`demo-feed` 只是替它们用假数据站个位。

### 5.4 接你自己的源（recipe，都可替换）

下面是“我这边怎么接的”，**只是示例，不是必需**，也不是内置工作代码。挑一个适合你平台的就行。

**手机快捷指令** —— iPhone 用 Shortcuts 的「获取 URL 内容」对 `POST /events` 发一包 JSON（app 名、地点、一句话）。**很多人不是 iPhone**：Android 的「快捷指令」/ Tasker / 任意能发 HTTP 的自动化都一样，端点不变。

**日历** —— 写个定时脚本把你日历里近 N 天的事件同步成 `pwa_kv[calendar]`（或 `store_rows` 的 `calendar` collection）行，前端就能显示。源是 Google 日历还是本地日历、还是别的，无所谓 —— 同步进同一张表即可。

**邮箱** —— 定时拉信，把要紧的写成 `events` 行（`source` 标账户）。任意 IMAP / 邮箱都行，不锁定某家。

> 说明（诚实标注）：公开核把 `EventType` enum 精简到了 8 类，`EMAIL_ARRIVAL` / `LOCATION` 这些专用类型没保留 —— 上面的邮箱 / 地点 recipe 用 `MANUAL_NOTE` 或 `SYSTEM` + `source` 标注即可。日历 / 邮箱的同步是 recipe，不是内置；`demo-feed` 与 `POST /events` 才是开箱能跑的部分。

### 5.5 两张表的角色

- **`events`** = 事件溯源脊柱。append-only 的信号流，是 reentry / 自主层 / 各种 dashboard 的共同底料。
- **`pwa_kv`** = 前端 KV 桥。一张 `namespace`/`key`/`payload` 表装所有前端状态，加新前端面不用迁移 schema。

两者都在公开 schema 里（`packages/db/prisma/schema.prisma`）。把外部信号接进这两张表，dashboard 就从“被布置好的房间”变成“自己在动的房间”。

---

## 6. 一个端到端的例子：论文 → 房间

`paper` 扩展把上面两个 seam 用在一处，是「自动 digest + 前端美化」的完整样例：

- **自动 digest（actions）**：设了 `PAPER_LOOP_CRON` 时，`registerActions` 在 daemon 里按 cron 跑 `runPaperLoop()` —— 从一个 `SourceAdapter`（默认 PubMed，可换 arXiv / 任意源）拉近期论文，LLM 蒸成一句知识点，写进 `paper_notes`（按 externalId 去重）。不设 cron 就只挂工具、不自动爬；手动 `npm run paper:loop` 照常。
- **结构化读（tools）**：`paper_list` 返回 JSON（不是 RAG 文本），给前端按 importance / pinned / 月份渲染；`paper_search` 仍是给 agent 的文本检索。
- **房间美化**：kimi-room 的 `/room/study/papers` 在 core 模式下调 `paper_list` 读 `paper_notes`，离线 / 未接 core 时用一批虚构 demo 论文，所以页面开箱即好看（深色巴洛克 + 衬线 + 描金）。

启用：`KIMI_EXTENSIONS=paper` + 可选 `PAPER_LOOP_CRON="0 9 * * *"`；room 设 `NEXT_PUBLIC_KIMI_ADAPTER=core`。
