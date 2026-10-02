import { Harness } from "./harness";

const RUNNER_SITE_URL = "https://dabench.ai";
const RUNNER_SITE_NAME = "DaBench";

export const OPENROUTER_ATTRIBUTION_HEADERS = { "HTTP-Referer": RUNNER_SITE_URL, "X-Title": RUNNER_SITE_NAME };

export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
/** Where the OpenAI client sends a run that names no base URL of its own. */
export const OPENAI_BASE_URL_ENV = "OPENAI_BASE_URL";
export const OPENAI_API_URL = "https://api.openai.com/v1";

export const DEFAULT_BASE_URLS = {
  [Harness.OpenRouter]: "https://openrouter.ai/api/v1",
  [Harness.Ollama]: "http://localhost:11434/v1",
  [Harness.Vllm]: "http://localhost:8000/v1",
  [Harness.LlamaCpp]: "http://localhost:8080/v1",
} as const satisfies Partial<Record<Harness, string>>;
