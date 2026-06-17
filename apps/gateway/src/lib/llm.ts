import { fetchWithRetry } from "../fetch-retry.js";

// Default model id for short, single-shot completions. Override per call via
// opts.model, or globally via the LLM_SHORT_MODEL env var. Any OpenRouter model
// slug works (e.g. "openai/gpt-4o-mini", "anthropic/claude-haiku-4-5").
const DEFAULT_SHORT_MODEL = process.env.LLM_SHORT_MODEL || "anthropic/claude-haiku-4-5";
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
  const model = opts.model ?? DEFAULT_SHORT_MODEL;
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
