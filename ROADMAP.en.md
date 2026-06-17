# Roadmap

> 中文版: [ROADMAP.md](./ROADMAP.md)

Deliberately not in the core yet — named honestly rather than implied:

- **SQLite storage backend.** The engine runs on Postgres + pgvector today (one
  `DATABASE_URL`, local via Docker or any remote). A repository-interface
  abstraction plus a SQLite + sqlite-vec backend would give a zero-dependency
  "lite" mode (no Docker, no server). The reranker is already plugin-shaped
  (`RERANK_PROVIDER`: none / local / cohere / jina / voyage); storage is not yet
  — it's the next pluggable boundary.

- **Autonomous wake (daemon).** Self-drive computes *which* dimensions and
  concerns to surface (`deriveDrives` / `deriveConcerns`); a cron-driven wake
  loop that acts on them is left to you to wire on your own schedule.

- **Conversational onboarding.** `npm run init` is a CLI questionnaire today; a
  chat-style persona builder (the way a persona is actually grown, not filled in
  a form) is a v2.
