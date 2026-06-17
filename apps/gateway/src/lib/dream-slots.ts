// Shared briefing-slot logic for the wake watchdog (http-server) + startup
// catch-up. Single source of truth so the "did a slot fire?" check is identical
// on both sides.
//
// Background: briefing wakes are scheduled at fixed local-time slots by a
// separate process. If that process crashes or loads a stale client, those
// wakes silently stop and no briefing is produced. A successful wake() writes an
// eventType=DREAM row at the END of its try block, so "DREAM event since slot T"
// == "the slot-T briefing fired".
//
// Slot hours, grace, and window are tunable via env (see config.example.yaml
// dreamSlots.*).

import prisma from "../db.js";

// Local-clock hours at which briefing wakes are scheduled.
export const SLOT_HOURS_LOCAL: number[] = (() => {
  try {
    const raw = process.env.DREAM_SLOT_HOURS;
    if (raw) return JSON.parse(raw);
  } catch {
    /* fall through to default */
  }
  return [9, 21];
})();

// UTC offset (hours) of the local clock the slots are expressed in.
const TZ_OFFSET_HOURS = Number(process.env.TZ_OFFSET_HOURS ?? 0);

// A slot only counts as "should have fired" once it's GRACE_MS past (a wake
// takes time; give margin). Misses older than WINDOW_MS are NOT chased — if the
// box was down for hours we don't want a stale catch-up firing a useless late
// push.
const GRACE_MS = Number(process.env.DREAM_GRACE_MINUTES ?? 12) * 60 * 1000;
const WINDOW_MS = Number(process.env.DREAM_WINDOW_HOURS ?? 3) * 60 * 60 * 1000;

// UTC instant of `hh:00` local on the local-calendar date of `now` (+dayOffset).
function slotInstant(now: Date, hh: number, dayOffset: number): Date {
  const local = new Date(now.getTime() + TZ_OFFSET_HOURS * 3600_000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  // hh:00 local == that wall time minus the offset in UTC.
  return new Date(Date.UTC(y, m, d + dayOffset, hh, 0, 0, 0) - TZ_OFFSET_HOURS * 3600_000);
}

// The most recent slot instant <= now. Includes yesterday's last slot so the
// wrap across midnight (checking just after midnight for a missed late slot) is
// handled.
export function mostRecentSlot(now: Date): Date {
  const lastHour = SLOT_HOURS_LOCAL[SLOT_HOURS_LOCAL.length - 1];
  const candidates = [
    slotInstant(now, lastHour, -1),
    ...SLOT_HOURS_LOCAL.map((hh) => slotInstant(now, hh, 0)),
  ]
    .filter((s) => s.getTime() <= now.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
  return candidates[candidates.length - 1];
}

// Returns the slot Date if the most-recent slot was MISSED (passed grace, within
// window, and no DREAM event written since it), else null. A normal restart
// after a successful slot returns null (DREAM event exists) — so only genuine
// misses fire, not unconditional startup wakes.
export async function missedSlot(now: Date = new Date()): Promise<Date | null> {
  const slot = mostRecentSlot(now);
  const age = now.getTime() - slot.getTime();
  if (age < GRACE_MS || age > WINDOW_MS) return null;
  const dream = await prisma.event.findFirst({
    where: { eventType: "DREAM", createdAt: { gte: slot } },
  });
  return dream ? null : slot;
}
