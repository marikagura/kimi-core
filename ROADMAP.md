> English: ./ROADMAP.en.md

# Roadmap

刻意尚未纳入 core——如实命名，而非暗示：

- **SQLite storage backend。** 引擎目前运行在 Postgres + pgvector 上（一个
  `DATABASE_URL`，本地经 Docker 或任意远端）。一层 repository-interface
  抽象再加上 SQLite + sqlite-vec backend，将提供一个零依赖的
  "lite" 模式（无 Docker、无 server）。reranker 已经是 plugin 形态
  （`RERANK_PROVIDER`：none / local / cohere / jina / voyage）；storage 还不是
  ——它是下一个可插拔的边界。

- **Autonomous wake (daemon)。** Self-drive 计算出*哪些*维度和
  concerns 需要浮现（`deriveDrives` / `deriveConcerns`）；一个由 cron 驱动、
  对它们采取行动的 wake loop，留给你按自己的 schedule 去接。

- **Conversational onboarding。** `npm run init` 目前是一个 CLI 问卷；一个
  chat 风格的 persona 构建器（persona 真正被养成的方式，而非在表单里
  填出来）是 v2。
