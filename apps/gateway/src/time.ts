// Human-facing datetime formatters — the single source of truth for display time.
// DB storage stays UTC — only convert on display.
//
// Display timezone is read from the KIMI_TZ env var (IANA name, e.g.
// "Asia/Shanghai", "America/New_York"). Defaults to Asia/Shanghai (China) when
// unset — change it per deployment. Everything (date, datetime, weekday, and the
// numeric offset used for arithmetic) derives from this ONE value, so the weekday
// / hour can never disagree with the date.

const TZ = process.env.KIMI_TZ || "Asia/Shanghai";

const _fmt = (opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, ...opts });

const _datetime = _fmt({
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit",
});

const _date = _fmt({ year: "numeric", month: "2-digit", day: "2-digit" });

// "2026-04-15 22:24" in the configured timezone.
export const localDateTime = (d: Date) => _datetime.format(d).replace("T", " ");

// "2026-04-15" in the configured timezone.
export const localDate = (d: Date) => _date.format(d);

// Weekday name ("Monday") in the configured timezone. Derive the day of week from
// this (Intl), never from a numeric offset + getUTCDay — that desyncs from the date.
const _weekday = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long" });
export const localWeekday = (d: Date): string => _weekday.format(d);

// Offset of the configured timezone at instant `d`, in milliseconds (DST-correct).
// For date arithmetic that must land on a local wall-clock hour (e.g. "today 09:00
// local" as a UTC instant). Single source of truth — no separate offset env var.
export function tzOffsetMs(d: Date): number {
  // Read d's wall-clock fields in TZ, reinterpret them as if UTC, and diff against
  // the real instant → the zone's offset at d.
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d).reduce<Record<string, number>>((a, x) => {
    if (x.type !== "literal") a[x.type] = Number(x.value);
    return a;
  }, {});
  const hour = p.hour === 24 ? 0 : p.hour; // some envs emit hour 24 at midnight
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, hour, p.minute, p.second);
  return asUtc - d.getTime();
}
