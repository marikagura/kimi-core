# 一体模式 · kimi-core 当唯一后端

kimi-core 默认是个记忆引擎（agent-text / RAG）。开了 `store` 扩展后，它还提供前端要的
**结构化数据 store**（`store` 工具）+ 一个**仪表盘快照**（`state_snapshot`）——于是一个前端可以
把同一个 core 当唯一后端：记忆、dashboard 数据、状态快照都从这里走。

配套前端（都可选，各自也能不连 core 单飞）：

- **[kimi-room](https://github.com/marikagura/kimi-room)** —— companion PWA。设
  `NEXT_PUBLIC_KIMI_BACKEND=core` + `NEXT_PUBLIC_KIMI_ADAPTER=core`，记忆 RAG 和 dashboard 数据都连这个 core。
- **[kimi-manor](https://github.com/marikagura/kimi-manor)** —— Electron 桌面仪表盘。设
  `KIMI_CORE_URL` + `KIMI_API_KEY`，`server.mjs` 调 `state_snapshot` 渲染。

## 跑起来（三步）

```bash
# 1) 起库 + core（开 store 扩展）
cd kimi-core
docker compose up -d                       # Postgres + pgvector
cp .env.example .env                        # 填 KIMI_API_KEY / LLM_*；并设 KIMI_EXTENSIONS=store
npm install && npm run db:migrate:deploy    # 建表（含 store_rows）
npm run dev                                 # 网关 → :3001  ·  POST /mcp (Bearer)

# 2) room 连这个 core
cd ../kimi-room
NEXT_PUBLIC_KIMI_BACKEND=core \
NEXT_PUBLIC_KIMI_ADAPTER=core \
KIMI_CORE_URL=http://localhost:3001 \
KIMI_API_KEY=<与 core 相同> \
npm install && npm run dev                  # → :3000

# 3)（可选）manor 仪表盘
cd ../cc-gild
npm install @modelcontextprotocol/sdk
KIMI_CORE_URL=http://localhost:3001 KIMI_API_KEY=<与 core 相同> node server.mjs   # → :7681/atelier
```

记忆 RAG（`memory_search`）和 dashboard 数据（`store`）从此走一个 core。

不想上 core 也行——这是递进的，不是绑定：room 可以单飞（idb / supabase / 本地 prisma，见 room
的 `docs/SELF-HOST.md`）；manor 可以不跑 core、只用 `DATABASE_URL` 直读同一个 Postgres 的
`store_rows`（见 manor 的 `STATE-SCHEMA.md`）。

> 全容器化的单命令 compose 需要给 core / room 各写一个 Dockerfile（仓里暂未带）；上面这套是当前可
> 直接跑的接法。
