import { fetchWithRetry } from "../fetch-retry.js";
import { roleModel, llmBaseUrl, llmApiKey } from "./models.js";

// Model for short, single-shot completions: opts.model per call, else the
// LLM_SHORT_MODEL env var, else the shared KIMI_MODEL. No built-in default —
// bring your own (see lib/models.ts).
const DEFAULT_MAX_TOKENS = 200;

/**
 * Minimal LLM caller against the configured OpenAI-compatible endpoint, for
 * scenarios that need a single short text completion (e.g. summarizing one email).
 * Larger callers with tool calls and cost logging live elsewhere.
 */
export async function callLLMShort(
  system: string,
  user: string,
  opts: { model?: string; maxTokens?: number } = {},
): Promise<string> {
  const model = opts.model ?? roleModel("LLM_SHORT_MODEL");
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  const res = await fetchWithRetry(`${llmBaseUrl()}/chat/completions`, {
    // LLM completions can run past the 60s fetch default; give them room.
    timeoutMs: 180_000,
    method: "POST",
    headers: {
      Authorization: `Bearer ${llmApiKey()}`,
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
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as any;
  return data?.choices?.[0]?.message?.content?.trim() ?? "";
}
