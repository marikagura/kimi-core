import { fetchWithRetry } from "../fetch-retry.js";
import { roleModel } from "./models.js";

// Model for short, single-shot completions: opts.model per call, else the
// LLM_SHORT_MODEL env var, else the shared KIMI_MODEL. No built-in default —
// bring your own (see lib/models.ts).
const DEFAULT_MAX_TOKENS = 200;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Minimal LLM caller via OpenRouter, for scenarios that need a single short
 * text completion (e.g. summarizing one email). Larger callers with tool calls
 * and cost logging live elsewhere.
 */
export async function callLLMShort(
  system: string,
  user: string,
  opts: { model?: string; maxTokens?: number } = {},
): Promise<string> {
  const model = opts.model ?? roleModel("LLM_SHORT_MODEL");
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set");

  const res = await fetchWithRetry(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
    }),
  });
  const data = (await res.json()) as any;
  return data?.choices?.[0]?.message?.content?.trim() ?? "";
}
