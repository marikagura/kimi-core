// Parse a numeric env var with a safe fallback. `Number(process.env.X ?? d)`
// silently yields NaN when X is set to a non-number (`??` only catches undefined),
// and NaN then propagates through drive / concern / pricing math undetected. This
// falls back (with a warning) on unset OR non-numeric, so a typo'd tuning value is
// loud rather than silently corrupting.
export function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[env] ${name}="${raw}" is not a number — using default ${fallback}`);
    return fallback;
  }
  return n;
}
