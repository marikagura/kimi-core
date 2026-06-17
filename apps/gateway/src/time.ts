// Human-facing datetime formatters.
// DB storage stays UTC — only convert on display.
//
// Display timezone is read from the KIMI_TZ env var (IANA name, e.g.
// "America/New_York", "Europe/London"). Defaults to UTC when unset.

const TZ = process.env.KIMI_TZ || "UTC";

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

// Backward-compatible aliases (call sites historically imported these names).
export const jst = localDateTime;
export const jstDate = localDate;
