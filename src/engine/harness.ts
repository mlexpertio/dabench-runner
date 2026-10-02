export enum Harness {
  OpenAI = "openai",
  OpenRouter = "openrouter",
  Ollama = "ollama",
  LlamaCpp = "llama.cpp",
  Vllm = "vllm",
}

const HARNESS_BY_LETTERS = new Map(Object.values(Harness).map((harness) => [lettersOnly(harness), harness]));
const LOCAL_HARNESSES = new Set<Harness>([Harness.LlamaCpp, Harness.Ollama, Harness.Vllm]);

export function knownHarness(harness: string): Harness | null {
  return HARNESS_BY_LETTERS.get(lettersOnly(harness)) ?? null;
}

/** Whether the harness is an inference engine that serves models on the operator's own machine. */
export function isLocalHarness(harness: string): boolean {
  const known = knownHarness(harness);
  return known !== null && LOCAL_HARNESSES.has(known);
}

function lettersOnly(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}
