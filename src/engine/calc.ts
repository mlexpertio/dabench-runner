export const CHARS_PER_TOKEN = 4;

export const MS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;
const USD_DECIMAL_SCALE = 1e8;
const PARAMS_PER_BILLION = 1e9;
export const BYTES_PER_MB = 1024 * 1024;
export const RUNTIME_MEMORY_OVERHEAD_FACTOR = 1.2;
export const RUNTIME_MEMORY_BASE_MB = 500;
const MAX_PLAUSIBLE_PARAMS_BILLIONS = 100000;
const HUNDREDTHS = 100;

export function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / CHARS_PER_TOKEN));
}

export function splitReasoningTokens(completionTokens: number, reasoningChars: number, answerChars: number): number {
  if (reasoningChars <= 0) return 0;
  if (answerChars <= 0) return completionTokens;
  return Math.round(completionTokens * (reasoningChars / (reasoningChars + answerChars)));
}

export function answerTokens(completionTokens: number, reasoningTokens: number): number {
  return Math.max(0, completionTokens - reasoningTokens);
}

export function reasoningShare(reasoningTokens: number, completionTokens: number): number {
  return completionTokens > 0 ? reasoningTokens / completionTokens : 0;
}

/** Output that all arrives within this window came in one burst, too fast to time a rate from. */
export const MIN_TIMED_WINDOW_MS = 250;

export function isTimedWindow(elapsedMs: number): boolean {
  return elapsedMs >= MIN_TIMED_WINDOW_MS;
}

/** Tokens per second, or 0 when the window is too short to time. */
export function throughput(tokens: number, elapsedMs: number): number {
  return isTimedWindow(elapsedMs) ? tokens / (elapsedMs / MS_PER_SECOND) : 0;
}

export function contextFill(usedTokens: number, contextWindow: number | null | undefined): number | null {
  if (!contextWindow || contextWindow <= 0) return null;
  return Math.max(0, Math.min(1, usedTokens / contextWindow));
}

export interface ApiPricing {
  promptUsdPerToken: number;
  completionUsdPerToken: number;
}

export interface ApiUsage {
  promptTokens: number;
  completionTokens: number;
}

export function apiCost(usage: ApiUsage, pricing: ApiPricing): number {
  return roundUsd(
    usage.promptTokens * pricing.promptUsdPerToken + usage.completionTokens * pricing.completionUsdPerToken,
  );
}

export const DEFAULT_GPU_HOURLY_USD = 0.5;

export interface LocalAssumptions {
  gpuHourlyUsd: number;
}

/** What a run is billed on: GPU time for a local run, list price per token for a hosted one, or nothing known. */
export type CostBasis = LocalAssumptions | ApiPricing | null;

export function localCost(gpuMs: number, a: LocalAssumptions): number {
  const hours = gpuMs / MS_PER_SECOND / SECONDS_PER_HOUR;
  return roundUsd(hours * a.gpuHourlyUsd);
}

/** A zero cost means the run recorded none. */
export function costPerPass(costUsd: number, passed: number): number | null {
  return costUsd > 0 && passed > 0 ? roundUsd(costUsd / passed) : null;
}

const P90_RANK = 0.9;

/** Nearest-rank 90th percentile: the smallest reading that at least 90% of readings don't exceed. */
export function p90(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(P90_RANK * sorted.length) - 1];
}

function roundUsd(usd: number): number {
  return Math.max(0, Math.round(usd * USD_DECIMAL_SCALE) / USD_DECIMAL_SCALE);
}

export function modelMemoryMb(paramsBillions: number, quant?: string): number {
  const weightsMb = (paramsBillions * PARAMS_PER_BILLION * bytesPerWeight(quant ?? null)) / BYTES_PER_MB;
  return weightsMb * RUNTIME_MEMORY_OVERHEAD_FACTOR + RUNTIME_MEMORY_BASE_MB;
}

export function paramsBillionsFromId(...names: string[]): number | null {
  const hay = names.join(" ").toLowerCase();
  const moe = hay.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*b\b/u);
  if (moe) return Number(moe[1]) * Number(moe[2]);
  const one = hay.match(/(\d+(?:\.\d+)?)\s*b\b/u);
  if (one) {
    const n = Number(one[1]);
    if (Number.isFinite(n) && n > 0 && n < MAX_PLAUSIBLE_PARAMS_BILLIONS) return n;
  }
  return null;
}

const BITS_PER_WEIGHT = /(\d+(?:\.\d+)?)\s*BPW/u;
const BITS_PER_BYTE = 8;
const HALF_PRECISION_BITS = 16;
const QUANT_BITS: [RegExp, number][] = [
  [/FP?32|FLOAT32/u, 32],
  [/FP8|Q8|INT8|8-?BIT/u, 8],
  [/Q6/u, 6.56],
  [/Q5/u, 5.6],
  [/Q4|NF4|MXFP4|INT4|4-?BIT|AWQ|GPTQ/u, 4.48],
  [/FP6/u, 6],
  [/FP4/u, 4],
  [/Q3/u, 3.52],
  [/Q2/u, 2.72],
  [/FP16|BF16|F16/u, HALF_PRECISION_BITS],
];

export function quantBits(quant: string | null): number | null {
  const q = (quant ?? "").toUpperCase();
  const bpw = q.match(BITS_PER_WEIGHT);
  if (bpw) return Number(bpw[1]);
  return QUANT_BITS.find(([pattern]) => pattern.test(q))?.[1] ?? null;
}

function bytesPerWeight(quant: string | null): number {
  return (quantBits(quant) ?? HALF_PRECISION_BITS) / BITS_PER_BYTE;
}

/** A side is clearly better when it wins more than half the untied test cases with at least this probability. */
export const CLEAR_PROBABILITY = 0.95;
const HALF = 0.5;

/**
 * Chance the side with `wins` wins more than half of untied test cases like these,
 * from a uniform prior: Beta(1 + wins, 1 + losses) mass above 1/2, which equals
 * P(Binomial(wins + losses + 1, 1/2) <= wins). Summed in log space so large suites don't underflow.
 */
function winProbability(wins: number, losses: number): number {
  const n = wins + losses + 1;
  let logTerm = n * Math.log(HALF);
  let sum = 0;
  for (let k = 0; k <= wins; k++) {
    sum += Math.exp(logTerm);
    logTerm += Math.log(n - k) - Math.log(k + 1);
  }
  return Math.min(1, sum);
}

/** Fewest wins, out of test cases where two models differ, that make one clearly better. Null when no count is enough. */
export function winsNeeded(differing: number): number | null {
  for (let wins = Math.ceil(differing / 2); wins <= differing; wins++)
    if (winProbability(wins, differing - wins) >= CLEAR_PROBABILITY) return wins;
  return null;
}

export function isClearSplit(wins: number, losses: number): boolean {
  const p = winProbability(wins, losses);
  return p >= CLEAR_PROBABILITY || p <= 1 - CLEAR_PROBABILITY;
}

export function round2(n: number): number {
  return Math.round(n * HUNDREDTHS) / HUNDREDTHS;
}
