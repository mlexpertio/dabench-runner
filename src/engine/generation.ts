import { isRecord } from "./guards";
import { Harness, knownHarness } from "./harness";
import type { CategoryGeneration } from "./schema";

type ProviderParameters = Record<string, unknown>;

const REASONING_CONTROL_KEYS = [
  "reasoning",
  "reasoning_effort",
  "thinking_budget_tokens",
  "thinking_token_budget",
  "max_tokens",
  "max_completion_tokens",
];

function withoutReasoningControls(parameters: ProviderParameters): ProviderParameters {
  const next = { ...parameters };
  for (const key of REASONING_CONTROL_KEYS) delete next[key];
  return next;
}

export function withSuiteBudgets(
  harness: string,
  parameters: ProviderParameters | undefined,
  generation: CategoryGeneration,
): ProviderParameters {
  const provider = knownHarness(harness);
  const existing = parameters ?? {};
  const next = withoutReasoningControls(existing);
  next[provider === Harness.OpenAI ? "max_completion_tokens" : "max_tokens"] = generation.maxOutputTokens;

  switch (provider) {
    case Harness.LlamaCpp:
      next.thinking_budget_tokens = generation.reasoningTokens;
      break;
    case Harness.Vllm:
      next.thinking_token_budget = generation.reasoningTokens;
      break;
    case Harness.OpenRouter: {
      const {
        effort: _effort,
        max_tokens: _maxTokens,
        ...reasoning
      } = isRecord(existing.reasoning) ? existing.reasoning : {};
      next.reasoning = { ...reasoning, max_tokens: generation.reasoningTokens };
      break;
    }
    default:
      next.reasoning_effort = generation.reasoningEffort;
  }

  return next;
}
