// Pull the first top-level JSON object out of an LLM response (models often wrap it
// in prose / markdown fences). The greedy {…} match + tolerant parse was identical
// at six call sites — one helper so they can't drift. Returns null on no match or
// bad JSON; callers decide the fallback.
export function firstJsonObject<T = any>(raw: string): T | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}
