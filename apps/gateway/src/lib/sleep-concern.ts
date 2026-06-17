// DATA-concern probe — example domain (self-concern engine).
//
// This is a worked example of the DATA-grounded concern path: take an external
// stream of numeric data windows, compare against configured thresholds, and
// project the result into a canonical Memory(experiencer=SELF, grounding=DATA,
// concernKey=...). The deriver (concern-derive.ts) later projects that Memory
// into an ActiveState — this file does NOT touch ActiveState.
//
// The mechanism is generic: swap in whichever metric domain you monitor. Data
// windows are read from a generic pwaKv-backed source; thresholds, the concern
// key, and the "real driver" text are all config-driven (see config.example.yaml
// dataProbe.*). No private domain details live here.
//
// Status gradient: a sustained deficit (avg below threshold) → OPEN; a
// short-window-driven deficit that's recovering on the most recent window →
// EASING; clean → RESOLVED.

import prisma from "../db.js";

const CONCERN_KEY = process.env.DATA_PROBE_CONCERN_KEY ?? "data_debt";

// Fallback thresholds (used when no baseline row is configured).
const FALLBACK = {
  weeklyAvg: Number(process.env.DATA_PROBE_WEEKLY_AVG ?? 7),
  shortValue: Number(process.env.DATA_PROBE_SHORT_VALUE ?? 4),
  shortCount: Number(process.env.DATA_PROBE_SHORT_COUNT ?? 2),
};
const WINDOW_N = Number(process.env.DATA_PROBE_WINDOW_N ?? 7);

// A single data window: a measured value over some span.
export type DataWindow = { value: number };

type ProbeBaseline = {
  thresholds?: { weeklyAvg?: number; shortValue?: number; shortCount?: number };
  realDriver?: string;
};

async function loadBaseline(): Promise<ProbeBaseline> {
  try {
    const row = await prisma.pwaKv.findUnique({
      where: { namespace_key: { namespace: "config", key: "data_probe_baseline" } },
    });
    return (row?.payload as ProbeBaseline) ?? {};
  } catch {
    return {};
  }
}

// Generic data source: read the last N window values from a pwaKv namespace.
// Swap this for your own data source. Expects payload rows with a numeric
// `value` field; returns most-recent-last.
async function lastNWindows(n: number): Promise<DataWindow[]> {
  try {
    const rows = await prisma.pwaKv.findMany({
      where: { namespace: "data_probe" },
      orderBy: { key: "desc" },
      take: n,
    });
    return rows
      .map((r): DataWindow | null => {
        const p = (r.payload ?? {}) as { value?: number };
        return typeof p.value === "number" ? { value: p.value } : null;
      })
      .filter((w): w is DataWindow => w !== null)
      .reverse();
  } catch {
    return [];
  }
}

export type ProbeStatus = "OPEN" | "EASING" | "RESOLVED";

export interface DataConcernResult {
  concerned: boolean;
  status: ProbeStatus;
  reason: string;
  avgValue: number;
  shortWindows: number;
  windows: number;
}

// Pure computation — values in, status out. No side effects, unit-testable.
export function computeDataStatus(
  windows: DataWindow[],
  th: { weeklyAvg: number; shortValue: number; shortCount: number },
): DataConcernResult {
  if (windows.length < 3) {
    return { concerned: false, status: "RESOLVED", reason: "insufficient_data", avgValue: 0, shortWindows: 0, windows: windows.length };
  }
  const avgValue = windows.reduce((s, w) => s + w.value, 0) / windows.length;
  const shortWindows = windows.filter((w) => w.value < th.shortValue).length;
  const mostRecent = windows[windows.length - 1];

  const avgLow = avgValue < th.weeklyAvg;
  const tooManyShort = shortWindows >= th.shortCount;
  const concerned = avgLow || tooManyShort;

  const reasons: string[] = [];
  if (avgLow) reasons.push(`avg ${avgValue.toFixed(1)} < ${th.weeklyAvg}`);
  if (tooManyShort) reasons.push(`${shortWindows} windows < ${th.shortValue}`);

  // Gradient:
  //   - sustained low average → OPEN (deficit persists even if the last window recovered)
  //   - short-driven + most recent window recovered → EASING (deficit not cleared but recovering)
  //   - short-driven + most recent still short → OPEN (active deficit)
  //   - no deficit but some short windows in range → EASING (just recovered); clean → RESOLVED
  let status: ProbeStatus;
  if (concerned) {
    if (avgLow) status = "OPEN";
    else status = mostRecent.value >= th.shortValue ? "EASING" : "OPEN";
  } else {
    status = shortWindows > 0 ? "EASING" : "RESOLVED";
  }

  return {
    concerned,
    status,
    reason: reasons.length ? reasons.join("; ") : status === "EASING" ? "recovering" : "ok",
    avgValue,
    shortWindows,
    windows: windows.length,
  };
}

function buildContent(r: DataConcernResult, realDriver: string): string {
  const driver = realDriver || "underlying driver (configure dataProbe.realDriver)";
  const stat =
    r.status === "OPEN"
      ? `Last ${r.windows} windows avg ${r.avgValue.toFixed(1)}, ${r.shortWindows} short. Trigger: ${r.reason}.`
      : r.status === "EASING"
      ? `Recovering but deficit not cleared (${r.windows} windows avg ${r.avgValue.toFixed(1)}, ${r.shortWindows} short). Watching.`
      : `Back in normal range (${r.windows} windows avg ${r.avgValue.toFixed(1)}, no short windows).`;
  // Always name the real driver rather than a surface symptom.
  return `${stat} Driver: ${driver}.`;
}

// felt-weight (axis 2): felt strength of this concern; does not gate existence,
// only adjusts display / damping.
function feltArousal(r: DataConcernResult): number {
  if (r.status === "RESOLVED") return 0.1;
  if (r.status === "EASING") return 0.35;
  return Math.min(0.8, 0.4 + 0.15 * r.shortWindows);
}

// Probe entry point. Upserts one canonical Memory(concernKey). The deriver
// projects it into an ActiveState. This does NOT touch ActiveState.
export async function checkDataConcern(): Promise<DataConcernResult> {
  const baseline = await loadBaseline();
  const th = {
    weeklyAvg: baseline.thresholds?.weeklyAvg ?? FALLBACK.weeklyAvg,
    shortValue: baseline.thresholds?.shortValue ?? FALLBACK.shortValue,
    shortCount: baseline.thresholds?.shortCount ?? FALLBACK.shortCount,
  };
  const windows = await lastNWindows(WINDOW_N); // real data, no mock
  const r = computeDataStatus(windows, th);

  const existing = await prisma.memory.findFirst({
    where: { concernKey: CONCERN_KEY, experiencer: "SELF", isActive: true },
    orderBy: { createdAt: "desc" },
  });

  // RESOLVED with no existing concern → nothing to record.
  if (r.status === "RESOLVED" && !existing) return r;

  const content = buildContent(r, baseline.realDriver ?? "");
  const valence = r.status === "RESOLVED" ? 0.1 : -0.4;
  const arousal = feltArousal(r);

  if (existing) {
    await prisma.memory.update({
      where: { id: existing.id },
      // Refresh summary too — surfaces read summary, so a stale one would freeze
      // the reason at creation time even after the data recovered to EASING.
      data: { summary: r.reason, content, resolution: r.status, valence, arousal, updatedAt: new Date() },
    });
  } else {
    await prisma.memory.create({
      data: {
        memoryType: "STATE",
        title: "DATA concern: monitored metric below threshold",
        summary: r.reason,
        content,
        importance: 4,
        sourceType: "EVENT",
        experiencer: "SELF",
        grounding: "DATA",
        concernKey: CONCERN_KEY,
        resolution: r.status,
        valence,
        arousal,
      },
    });
  }
  return r;
}
