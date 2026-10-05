export enum Harness {
  OpenRouter = "openrouter",
  OpenAI = "openai",
  Ollama = "ollama",
  Vllm = "vllm",
  LlamaCpp = "llama.cpp",
}

const RUNNER_SITE_URL = "https://dabench.ai";
const RUNNER_SITE_NAME = "DaBench";

export const OPENROUTER_ATTRIBUTION_HEADERS = { "HTTP-Referer": RUNNER_SITE_URL, "X-Title": RUNNER_SITE_NAME };
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
export const OPENAI_BASE_URL_ENV = "OPENAI_BASE_URL";
export const OPENAI_API_URL = "https://api.openai.com/v1";

export const DEFAULT_BASE_URLS = {
  [Harness.OpenRouter]: "https://openrouter.ai/api/v1",
  [Harness.Ollama]: "http://localhost:11434/v1",
  [Harness.Vllm]: "http://localhost:8000/v1",
  [Harness.LlamaCpp]: "http://localhost:8080/v1",
} as const satisfies Partial<Record<Harness, string>>;

const HARNESS_BY_LETTERS = new Map(Object.values(Harness).map((harness) => [lettersOnly(harness), harness]));
const LOCAL_HARNESSES = new Set<Harness>([Harness.LlamaCpp, Harness.Ollama, Harness.Vllm]);

export function knownHarness(harness: string): Harness | null {
  return HARNESS_BY_LETTERS.get(lettersOnly(harness)) ?? null;
}

export function isLocalHarness(harness: string): boolean {
  const known = knownHarness(harness);
  return known !== null && LOCAL_HARNESSES.has(known);
}

function lettersOnly(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}
