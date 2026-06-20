// Group time-ascending events into sessions by an idle gap: a gap longer than
// gapH hours between two consecutive events starts a new session. A session is a
// continuous conversation, independent of calendar day. Pure — the only field it
// needs is a `createdAt` timestamp, so it unit-tests with no DB. Callers must pass
// events already sorted ascending by createdAt (the digest query orders them so).
export function groupByIdleGap<T extends { createdAt: Date }>(events: T[], gapH: number): T[][] {
  const gapMs = gapH * 3600 * 1000;
  const sessions: T[][] = [];
  for (const e of events) {
    const cur = sessions[sessions.length - 1];
    const prevE = cur?.[cur.length - 1];
    if (!cur || e.createdAt.getTime() - prevE!.createdAt.getTime() > gapMs) {
      sessions.push([e]);
    } else {
      cur.push(e);
    }
  }
  return sessions;
}
