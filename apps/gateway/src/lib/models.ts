// kimi-core ships NO built-in model. The deployer brings their own, via env.
// Baking a specific model into the engine would mean it silently
// runs on someone else's model choice. Same stance as the empty persona: the
// engine doesn't choose for you.
//
//   KIMI_MODEL    — the default model for OpenRouter calls (intel / digests /
//                   short LLM helpers / depth judge). An OpenRouter slug, e.g.
//                   "anthropic/claude-..." or "openai/gpt-...". Per-role env vars
//                   (INTEL_MODEL, LLM_SHORT_MODEL, DEPTH_JUDGE_MODEL, …) override
//                   it; unset, they fall back to KIMI_MODEL.
//   DAEMON_MODEL  — the autonomous wake daemon (Claude Agent SDK). A BARE Claude
//                   model id (e.g. "claude-..."), NOT an OpenRouter slug — the SDK
//                   resolves it against your Claude subscription. No KIMI_MODEL
//                   fallback (different id format).
//   EMBED_MODEL   — embedding model (optional). Unset = no semantic arm (retrieval
//                   falls back to keyword/trigram). Must output the dimension the
//                   DB vector columns expect (shipped schema: vector(1536)).
//
// A required model that's unset is a clear, fail-closed error — never a silent
// default.

// Resolve a required model strictly from `envVar`. Throws if unset.
export function modelFor(envVar: string): string {
  const m = process.env[envVar]?.trim();
  if (!m) {
    throw new Error(
      `${envVar} is not set. kimi-core ships no built-in model — set ${envVar} to ` +
        `your own model (an OpenRouter slug like "anthropic/claude-..." or ` +
        `"openai/gpt-...", or a bare Claude id for the daemon). See .env.example.`,
    );
  }
  return m;
}

// Resolve a role's model: its own env var if set, else the shared KIMI_MODEL.
// Throws (via modelFor) if neither is set.
export function roleModel(roleEnvVar: string): string {
  const specific = process.env[roleEnvVar]?.trim();
  return specific || modelFor("KIMI_MODEL");
}

// Embedding model — optional. Returns null when unset (caller skips embedding).
export function embedModelOrNull(): string | null {
  return process.env.EMBED_MODEL?.trim() || null;
}

// Generic required-env reader for the provider endpoints below.
function requireEnv(name: string, hint: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`${name} is not set. kimi-core presets no provider — set ${name} (${hint}). See .env.example.`);
  }
  return v;
}

// LLM provider — an OpenAI-compatible chat-completions endpoint, brought by the
// deployer. No preset: works with any endpoint that speaks the OpenAI
// /chat/completions shape (OpenRouter, OpenAI, Together, Groq, a local vLLM /
// Ollama, …). The code appends "/chat/completions" to LLM_BASE_URL.
export function llmBaseUrl(): string {
  return requireEnv(
    "LLM_BASE_URL",
    'an OpenAI-compatible base, e.g. "https://api.openai.com/v1" / "https://openrouter.ai/api/v1" / "http://localhost:11434/v1"',
  ).replace(/\/+$/, "");
}
export function llmApiKey(): string {
  return requireEnv("LLM_API_KEY", "your LLM provider's API key");
}

// Embeddings provider — an OpenAI-compatible /embeddings endpoint. Optional: unset
// base/key = no semantic arm (same graceful path as EMBED_MODEL). Returns null when
// unset; the code appends "/embeddings" to EMBED_BASE_URL.
export function embedBaseUrlOrNull(): string | null {
  const v = process.env.EMBED_BASE_URL?.trim();
  return v ? v.replace(/\/+$/, "") : null;
}
export function embedApiKeyOrNull(): string | null {
  return process.env.EMBED_API_KEY?.trim() || null;
}
