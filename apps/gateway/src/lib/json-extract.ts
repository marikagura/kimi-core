// Pull the first top-level JSON object out of an LLM response (models often wrap it
// in prose / markdown fences). One helper so the six call sites can't drift. Returns
// null on no match or bad JSON; callers decide the fallback.
//
// A brace-balanced scan, NOT a greedy /\{[\s\S]*\}/ regex: that regex matched from
// the FIRST '{' to the LAST '}' in the whole string, so any stray brace in
// surrounding prose (chain-of-thought mentioning a set/array, a trailing sentence
// with a brace, or two emitted objects) made JSON.parse throw and dropped a valid
// object. Here we walk from each '{', track brace depth while ignoring braces inside
// double-quoted strings (respecting escapes), and return the first balanced slice
// that parses — so prose-with-braces and two-object outputs are handled.
export function firstJsonObject<T = any>(raw: string): T | null {
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          // First brace-balanced slice from this '{'. Parse it; if it isn't valid
          // JSON, fall through to try the next '{' in the string.
          try {
            return JSON.parse(raw.slice(start, i + 1)) as T;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}
