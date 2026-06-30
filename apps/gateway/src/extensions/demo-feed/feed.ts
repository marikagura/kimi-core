// demo-feed — an OPT-IN sample that SIMULATES an external automation source, so a
// viewer can watch the room fill itself without wiring real iOS Shortcuts / a
// calendar / a mailbox. On a timer it writes FICTIONAL signals into (a) the events
// spine and (b) the store_rows collections the room renders (calendar / keepsake /
// chat). Point a room at this core (NEXT_PUBLIC_KIMI_ADAPTER=core) and the
// dashboard updates on its own. Enable with KIMI_EXTENSIONS=demo-feed.
//
// Runnable counterpart to docs/EXTENSIONS.md (§5 Ingest): real sources feed the same tables;
// this stands in for them with fake data on a schedule. ALL CONTENT IS FICTIONAL.

import cron from "node-cron";
import { Prisma, EventType } from "@prisma/client";
import prisma from "../../db.js";
import { localDate, localDateTime, DEFAULT_TZ } from "../../time.js";
import { entryToRow, nowISO, type StoreEntry } from "../store/store-shared.js";
import type { KimiExtension } from "../../lib/extensions.js";

// Fictional, neutral signals — no real person or place. Rotated by a tick counter
// (no RNG) so the feed is deterministic and easy to follow in logs and tests.
type Signal = { collection: string; event: string; make: (n: number, now: Date) => StoreEntry };

const SIGNALS: Signal[] = [
  {
    collection: "calendar",
    event: "calendar entry",
    make: (n, now) => ({
      id: `demo-feed-cal-${localDate(now)}`,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      date: localDate(now),
      title: `stand-up ${9 + (n % 9)}:00`,
      body: "demo-feed · 虚构示例 / fictional",
    }),
  },
  {
    collection: "keepsake",
    event: "saved a moment",
    make: (n) => ({
      id: `demo-feed-keep-${n}`,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      title: ["morning coffee", "a quiet walk", "rain on the window", "first light"][n % 4],
      place: "—",
      record: "demo-feed · 虚构示例 / fictional",
      tags: ["demo"],
    }),
  },
  {
    collection: "chat",
    event: "a line arrived",
    make: (n, now) => ({
      id: `demo-feed-chat-${n}`,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      source: "demo",
      title: localDateTime(now).slice(0, 16),
      messages: [{ role: "user", content: `(demo-feed) fictional signal #${n}` }],
      theme: "day",
    }),
  },
];

let tickN = 0;

/** One feed tick: a row on the events spine + a row in a room-rendered collection. */
export async function demoFeedTick(now: Date = new Date()): Promise<void> {
  const sig = SIGNALS[tickN % SIGNALS.length];
  tickN += 1;
  const entry = sig.make(tickN, now);
  const row = entryToRow(sig.collection, entry);
  // (a) the events spine — the "a signal arrived" row (curl /events writes the same).
  await prisma.event.create({
    data: { eventType: EventType.APP_OPEN, value: `demo-feed: ${sig.event}`, source: "demo-feed" },
  });
  // (b) the room-rendered collection — what the dashboard shows.
  await prisma.storeRow.upsert({
    where: { id: row.id },
    create: {
      id: row.id,
      collection: row.collection,
      data: row.data as Prisma.InputJsonValue,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    },
    update: { data: row.data as Prisma.InputJsonValue, updatedAt: new Date(row.updatedAt) },
  });
  console.log(`[demo-feed] tick ${tickN}: event + ${sig.collection} (${row.id})`);
}

/** Opt-in: start the demo feed on a timer. Enable via KIMI_EXTENSIONS=demo-feed. */
export function registerDemoFeed(): void {
  const schedule = process.env.DEMO_FEED_CRON || "*/2 * * * *"; // every 2 minutes
  // Validate before scheduling: node-cron throws synchronously on a malformed
  // pattern, which would otherwise propagate out of the daemon's extension loader.
  if (!cron.validate(schedule)) {
    console.error(`[demo-feed] invalid DEMO_FEED_CRON "${schedule}" — skipping schedule`);
    return;
  }
  const tz = process.env.KIMI_CRON_TZ || DEFAULT_TZ;
  cron.schedule(
    schedule,
    () => {
      demoFeedTick().catch((e) => console.error("[demo-feed] tick error:", e?.message || e));
    },
    { timezone: tz },
  );
  console.log(`[demo-feed] started — cron "${schedule}" (${tz}). FICTIONAL data only.`);
}

/**
 * Opt-in extension wrapper. Enable by name via KIMI_EXTENSIONS=demo-feed
 * (registered in lib/enabled-extensions.ts). Daemon-side only (no MCP tools): it
 * implements the registerActions seam, which the daemon runs at startup.
 */
export const demoFeedExtension: KimiExtension = {
  name: "demo-feed",
  registerActions: registerDemoFeed,
};
