import { apiCost, localCost, MS_PER_SECOND, round2, throughput, type CostBasis } from "./calc";
import type { CaseMetrics, Cost, MemoryUsage, Metrics } from "./schema";

const USD = "USD";

interface TimedOutput {
  timedTokens: number;
  timedMs: number;
}

export interface CaseTiming extends TimedOutput {
  requestMs: number;
}

interface CaseMeasurement extends CaseTiming {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  vramMb: number | null;
}

export interface MeasuredCase {
  metrics: CaseMetrics;
  timed: TimedOutput;
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

export function recordedOutput({ tokens, tokensPerSecond }: CaseMetrics): TimedOutput {
  if (tokensPerSecond <= 0) return { timedTokens: 0, timedMs: 0 };
  return { timedTokens: tokens.completion, timedMs: (tokens.completion / tokensPerSecond) * MS_PER_SECOND };
}

export function runMetrics(cases: MeasuredCase[], memory: MemoryUsage | null): Metrics {
  const recorded = cases.map((c) => c.metrics);
  const prompt = total(recorded, (c) => c.tokens.prompt);
  const completion = total(recorded, (c) => c.tokens.completion);
  const rated = recorded.filter((c) => c.tokensPerSecond > 0);
  const mean = (items: CaseMetrics[], pick: (c: CaseMetrics) => number) =>
    items.length === 0 ? 0 : round2(total(items, pick) / items.length);

  return {
    tokens: { prompt, completion, reasoning: total(recorded, (c) => c.tokens.reasoning), total: prompt + completion },
    tokensPerSecond: round2(
      throughput(
        total(cases, (c) => c.timed.timedTokens),
        total(cases, (c) => c.timed.timedMs),
      ),
    ),
    avgTokensPerSecond: mean(rated, (c) => c.tokensPerSecond),
    avgCompletionTokens: mean(recorded, (c) => c.tokens.completion),
    avgReasoningTokens: mean(recorded, (c) => c.tokens.reasoning),
    latencyMs: total(recorded, (c) => c.latencyMs),
    vramMb: memory ? Math.max(0, Math.round(memory.peakMb)) : null,
    memory,
  };
}

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

function total<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((sum, item) => sum + pick(item), 0);
}

function clampInt(n: number): number {
  return Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
}
