import { fetchWithRetry } from "../fetch-retry.js";
import { roleModel, llmBaseUrl, llmApiKey } from "./models.js";

const DEFAULT_MAX_TOKENS = 200;

/**
 * Shared OpenAI-compatible chat completion: fetchWithRetry + auth headers + a
 * 180s per-attempt timeout (completions, esp. extended-thinking ones, can run
 * well past the 60s fetch default) + a `LLM <status>` throw on a non-ok response.
 * Returns the raw message content — callers apply their own trimming. providerOrder
 * (OpenRouter-style routing) and thinkingTokens are sent only when present; other
 * OpenAI-compatible endpoints ignore the unknown fields.
 */
export async function chatCompletion(args: {
  system: string;
  user: string;
  model: string;
  maxTokens: number;
  providerOrder?: string[];
  thinkingTokens?: number;
}): Promise<string> {
  const { system, user, model, maxTokens, providerOrder, thinkingTokens } = args;
  const res = await fetchWithRetry(`${llmBaseUrl()}/chat/completions`, {
    timeoutMs: 180_000,
    method: "POST",
    headers: {
      Authorization: `Bearer ${llmApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      ...(providerOrder?.length ? { provider: { order: providerOrder, allow_fallbacks: true } } : {}),
      ...(thinkingTokens ? { reasoning: { max_tokens: thinkingTokens } } : {}),
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
  const data = (await res.json()) as {
    error?: unknown;
    choices?: Array<{ message?: { content?: string } }>;
  };
  // Some OpenAI-compatible gateways (OpenRouter et al.) report upstream/moderation/
  // credit failures as HTTP 200 with an `{ "error": {...} }` envelope and no
  // `choices`. The !res.ok guard above never fires for those, and collapsing them to
  // "" makes a provider failure indistinguishable from a genuine empty completion.
  // Throw on the error envelope; warn when choices is absent so it's observable.
  if (data && typeof data === "object" && data.error != null) {
    throw new Error(`LLM provider error: ${JSON.stringify(data.error).slice(0, 200)}`);
  }
  if (!data?.choices) {
    console.warn("[llm] response had no choices array — returning empty completion");
  }
  return data?.choices?.[0]?.message?.content ?? "";
}

/**
 * Minimal LLM caller for a single short text completion (e.g. summarizing one
 * email). Larger callers with tool calls / cost logging live elsewhere. Trims the
 * result; defaults to a short max_tokens and the LLM_SHORT_MODEL role.
 */
export async function callLLMShort(
  system: string,
  user: string,
  opts: { model?: string; maxTokens?: number } = {},
): Promise<string> {
  const content = await chatCompletion({
    system,
    user,
    model: opts.model ?? roleModel("LLM_SHORT_MODEL"),
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
  });
  return content.trim();
}
