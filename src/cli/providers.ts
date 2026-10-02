import { Harness } from "../engine/harness";
import { DEFAULT_BASE_URLS, OPENROUTER_API_KEY_ENV, OPENROUTER_ATTRIBUTION_HEADERS } from "../engine/providers";
import type { RunConfigInput } from "../engine/runconfig";

const PROVIDER_PRESETS: Record<Harness, Partial<RunConfigInput>> = {
  [Harness.OpenRouter]: {
    openai: {
      baseUrl: DEFAULT_BASE_URLS[Harness.OpenRouter],
      apiKeyEnv: OPENROUTER_API_KEY_ENV,
      harness: Harness.OpenRouter,
      headers: OPENROUTER_ATTRIBUTION_HEADERS,
    },
  },
  [Harness.OpenAI]: {
    openai: { harness: Harness.OpenAI },
  },
  [Harness.Ollama]: {
    openai: { baseUrl: DEFAULT_BASE_URLS[Harness.Ollama], harness: Harness.Ollama, local: {} },
  },
  [Harness.Vllm]: {
    openai: { baseUrl: DEFAULT_BASE_URLS[Harness.Vllm], harness: Harness.Vllm, local: {} },
  },
  [Harness.LlamaCpp]: {
    openai: { baseUrl: DEFAULT_BASE_URLS[Harness.LlamaCpp], harness: Harness.LlamaCpp, local: {} },
  },
};

export const PROVIDER_NAMES: readonly string[] = [
  Harness.OpenRouter,
  Harness.OpenAI,
  Harness.Ollama,
  Harness.Vllm,
  Harness.LlamaCpp,
];

export function providerPreset(name: string): Partial<RunConfigInput> | undefined {
  return isProviderName(name) ? PROVIDER_PRESETS[name] : undefined;
}

function isProviderName(name: string): name is Harness {
  return PROVIDER_NAMES.includes(name);
}
