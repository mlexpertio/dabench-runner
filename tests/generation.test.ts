import { describe, expect, it } from "vitest";
import { withSuiteBudgets } from "../src/engine/generation";

const BALANCED = {
  reasoningTokens: 2048,
  reasoningEffort: "medium",
  maxOutputTokens: 4096,
} as const;
const DEEP = {
  reasoningTokens: 4096,
  reasoningEffort: "high",
  maxOutputTokens: 8192,
} as const;

describe("category generation provider mapping", () => {
  it.each([
    [
      "exact token budgets for llama.cpp",
      "llama.cpp",
      { seed: 42, max_tokens: 99999 },
      DEEP,
      { seed: 42, max_tokens: 8192, thinking_budget_tokens: 4096 },
    ],
    [
      "exact token budgets for vLLM",
      "vllm",
      { top_k: 40 },
      BALANCED,
      { top_k: 40, max_tokens: 4096, thinking_token_budget: 2048 },
    ],
    [
      "OpenRouter's normalized token budget",
      "openrouter",
      { reasoning: { effort: "low", exclude: true }, provider: { sort: "throughput" } },
      DEEP,
      { provider: { sort: "throughput" }, max_tokens: 8192, reasoning: { exclude: true, max_tokens: 4096 } },
    ],
    [
      "the suite's effort for a custom endpoint",
      "custom gateway",
      undefined,
      DEEP,
      { max_tokens: 8192, reasoning_effort: "high" },
    ],
    [
      "OpenAI's combined completion-token field for direct OpenAI calls",
      "openai",
      { max_tokens: 99 },
      DEEP,
      { max_completion_tokens: 8192, reasoning_effort: "high" },
    ],
  ])("uses %s", (_, harness, parameters, generation, expected) => {
    expect(withSuiteBudgets(harness, parameters, generation)).toEqual(expected);
  });
});
