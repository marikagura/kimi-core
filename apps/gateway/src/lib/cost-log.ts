// Unified LLM cost logger. Writes [cost:<kind>] to stdout (backward compat)
// AND persists to DB as Event{type:SYSTEM, source:"cost"} for the ops dashboard.
//
// OpenRouter surfaces provider cache stats under usage.prompt_tokens_details
// (cached_tokens = read hit, cache_write_tokens = write/create).
// Reasoning tokens live in completion_tokens_details.reasoning_tokens and are
// priced as output.
//
// Per-million-token prices. Defaults below are reasonable placeholders; set the
// env vars to match the model and provider you actually bill against. Mismatched
// prices only skew the estUsd column — they do not affect any LLM behavior.
import prisma from "../db.js";
import { numEnv } from "./env.js";
import { errMessage } from "./err.js";

const PRICE_CACHE_READ = numEnv("PRICE_CACHE_READ_PER_M", 0.5);
const PRICE_CACHE_WRITE = numEnv("PRICE_CACHE_WRITE_PER_M", 6.25);
const PRICE_FRESH_INPUT = numEnv("PRICE_INPUT_PER_M", 5);
const PRICE_OUTPUT = numEnv("PRICE_OUTPUT_PER_M", 25);

// Minimal shape of the OpenAI / OpenRouter `usage` object this reads (all optional).
type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
};

export async function logCost(kind: string, usage: unknown): Promise<void> {
  const u = (usage ?? {}) as Usage;
  const ptd = u.prompt_tokens_details ?? {};
  const ctd = u.completion_tokens_details ?? {};
  const cacheRead = ptd.cached_tokens ?? 0;
  const cacheCreate = ptd.cache_write_tokens ?? 0;
  const totalInput = u.prompt_tokens ?? 0;
  const reasoningTok = ctd.reasoning_tokens ?? 0;
  const outputTok = u.completion_tokens ?? 0;
  const freshInput = Math.max(0, totalInput - cacheRead - cacheCreate);
  const estUsd =
    (cacheRead * PRICE_CACHE_READ +
      cacheCreate * PRICE_CACHE_WRITE +
      freshInput * PRICE_FRESH_INPUT +
      outputTok * PRICE_OUTPUT) /
    1_000_000;

  console.log(
    `[cost:${kind}] reasoning=${reasoningTok} output=${outputTok} est=$${estUsd.toFixed(4)}`,
  );

  try {
    await prisma.event.create({
      data: {
        eventType: "SYSTEM",
        source: "cost",
        value: JSON.stringify({
          kind,
          reasoningTok,
          outputTok,
          inputTok: totalInput,
          cacheReadTok: cacheRead,
          cacheCreateTok: cacheCreate,
          freshInputTok: freshInput,
          estUsd: Number(estUsd.toFixed(6)),
        }),
      },
    });
  } catch (err: unknown) {
    console.error("[cost-log] DB write failed:", errMessage(err));
  }
}
