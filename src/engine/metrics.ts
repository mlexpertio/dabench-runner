import { apiCost, localCost, MS_PER_SECOND, round2, throughput, type CostBasis } from "./calc";
import type { CaseMetrics, Cost, MemoryUsage, Metrics } from "./schema";

const USD = "USD";

interface CaseMeasurement {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  requestMs: number;
  /** Output tokens and generating time of the model calls whose output streamed long enough to time. */
  timedTokens: number;
  timedMs: number;
  vramMb: number | null;
}

export function caseMetrics(m: CaseMeasurement): CaseMetrics {
  const completion = clampInt(m.completionTokens);
  const prompt = clampInt(m.promptTokens);
  const reasoning = Math.min(completion, clampInt(m.reasoningTokens));
  return {
    tokens: { prompt, completion, reasoning, total: prompt + completion },
    tokensPerSecond: round2(throughput(m.timedTokens, m.timedMs)),
    latencyMs: Math.max(0, Math.round(m.requestMs)),
    vramMb: m.vramMb === null ? null : Math.max(0, Math.round(m.vramMb)),
  };
}

/** The run's numbers, all derived from its recorded cases, so a resumed run adds up like a fresh one. */
export function runMetrics(cases: CaseMetrics[], memory: MemoryUsage | null): Metrics {
  const prompt = total(cases, (c) => c.tokens.prompt);
  const completion = total(cases, (c) => c.tokens.completion);
  const rated = cases.filter((c) => c.tokensPerSecond > 0);
  const mean = (items: CaseMetrics[], pick: (c: CaseMetrics) => number) =>
    items.length === 0 ? 0 : round2(total(items, pick) / items.length);

  return {
    tokens: { prompt, completion, reasoning: total(cases, (c) => c.tokens.reasoning), total: prompt + completion },
    tokensPerSecond: round2(
      throughput(
        total(rated, (c) => c.tokens.completion),
        total(rated, generationMs),
      ),
    ),
    avgTokensPerSecond: mean(rated, (c) => c.tokensPerSecond),
    avgCompletionTokens: mean(cases, (c) => c.tokens.completion),
    avgReasoningTokens: mean(cases, (c) => c.tokens.reasoning),
    latencyMs: total(cases, (c) => c.latencyMs),
    vramMb: memory ? Math.max(0, Math.round(memory.peakMb)) : null,
    memory,
  };
}

/** One reading over a resumed run's sessions; readings of different kinds can't be averaged, so the higher peak stands. */
export function mergeMemory(previous: MemoryUsage | null, current: MemoryUsage | null): MemoryUsage | null {
  if (!previous) return current;
  if (!current) return previous;
  if (previous.kind !== current.kind || previous.source !== current.source) {
    return previous.peakMb >= current.peakMb ? previous : current;
  }
  const samples = previous.samples + current.samples;
  return {
    kind: previous.kind,
    peakMb: Math.max(previous.peakMb, current.peakMb),
    avgMb: (previous.avgMb * previous.samples + current.avgMb * current.samples) / samples,
    samples,
    source: previous.source,
  };
}

export function runCost({ tokens, latencyMs }: Metrics, basis: CostBasis): Cost {
  if (basis && "gpuHourlyUsd" in basis) {
    return { amountUsd: localCost(latencyMs, basis), currency: USD, estimated: true };
  }
  const amountUsd = basis ? apiCost({ promptTokens: tokens.prompt, completionTokens: tokens.completion }, basis) : 0;
  return { amountUsd, currency: USD, estimated: false };
}

/** The time a case spent generating, recovered from its token count and rate. */
function generationMs(c: CaseMetrics): number {
  return (c.tokens.completion / c.tokensPerSecond) * MS_PER_SECOND;
}

function total<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((sum, item) => sum + pick(item), 0);
}

function clampInt(n: number): number {
  return Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
}
