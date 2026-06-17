// Human-facing datetime formatter for context-core.
//
// Mirrors the gateway's time.ts: display timezone comes from the KIMI_TZ env var
// (IANA name, e.g. "America/New_York"), defaulting to UTC. context-core is a
// standalone package, so it carries its own small copy rather than importing
// across a package boundary. DB storage stays UTC — only convert on display.

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
