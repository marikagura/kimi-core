#!/usr/bin/env node
/**
 * Preflight check, run before `npm run dev`.
 *
 * If the local setup isn't done yet, point the user at `npm run init` instead of
 * letting the engine crash with a raw "KIMI_API_KEY missing" / Prisma connection
 * error. This is the discoverability guard for people who skip the README and run
 * `npm run dev` first.
 *
 * User-facing strings are Chinese (the project's audience); code comments stay
 * English for contributors.
 */
import { access } from "node:fs/promises";

const has = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

async function main(): Promise<void> {
  const missing: string[] = [];
  if (!(await has(".env"))) missing.push(".env");
  if (!(await has("persona.md"))) missing.push("persona.md");

  if (missing.length === 0) return; // set up — let dev proceed

  console.error(`\n⚠  还没 onboarding —— 缺 ${missing.join(" / ")}。`);
  console.error("   引擎需要先建好本地配置和 persona,直接 dev 会报错。先跑:\n");
  console.error("     npm run init                # 问几个问题 → 生成 persona.md / AGENTS.md / .env");
  console.error("     npm run db:migrate:deploy   # 建库 (先 docker compose up -d 或指好 DATABASE_URL)");
  console.error("\n   然后再 npm run dev。详见 README。\n");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
