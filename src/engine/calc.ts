export const CHARS_PER_TOKEN = 4;

export const MS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;
const USD_DECIMAL_SCALE = 1e8;
export const BYTES_PER_MB = 1024 * 1024;
const HUNDREDTHS = 100;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export const MIN_TIMED_WINDOW_MS = 250;

export function isTimedWindow(elapsedMs: number): boolean {
  return elapsedMs >= MIN_TIMED_WINDOW_MS;
}

export function throughput(tokens: number, elapsedMs: number): number {
  return isTimedWindow(elapsedMs) ? tokens / (elapsedMs / MS_PER_SECOND) : 0;
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

export interface LocalAssumptions {
  gpuHourlyUsd: number;
}

export type CostBasis = LocalAssumptions | ApiPricing | null;

export function localCost(gpuMs: number, a: LocalAssumptions): number {
  const hours = gpuMs / MS_PER_SECOND / SECONDS_PER_HOUR;
  return roundUsd(hours * a.gpuHourlyUsd);
}

function roundUsd(usd: number): number {
  return Math.max(0, Math.round(usd * USD_DECIMAL_SCALE) / USD_DECIMAL_SCALE);
}

const BITS_PER_WEIGHT = /(\d+(?:\.\d+)?)\s*BPW/u;
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

export function round2(n: number): number {
  return Math.round(n * HUNDREDTHS) / HUNDREDTHS;
}
