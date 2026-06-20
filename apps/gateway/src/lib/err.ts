// Narrow an unknown caught value to a log string. Replaces the scattered
// `e: any` + `e?.message || e` / `e.message` / `(e as Error)?.message ?? e` idioms
// at the catch sites: `catch (e: unknown)` is the strict-mode default, and this
// keeps the behavior (an Error's message, else the value stringified) in one place.
export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
