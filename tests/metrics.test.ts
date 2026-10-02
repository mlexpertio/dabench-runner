import { describe, expect, it } from "vitest";
import { reasoningTagChars } from "dabench/engine/inline-reasoning";
import { caseMetrics, mergeMemory, runMetrics } from "dabench/engine/metrics";
import type { MemoryUsage } from "dabench/engine/schema";

const memoryFixture: MemoryUsage = {
  kind: "vram",
  peakMb: 14680.6,
  avgMb: 14100.25,
  samples: 12,
  source: "nvidia-smi (process)",
};

type CaseMeasurement = Parameters<typeof caseMetrics>[0];

const measurement = (over: Partial<CaseMeasurement> = {}): CaseMeasurement => ({
  promptTokens: 20,
  completionTokens: 60,
  reasoningTokens: 0,
  requestMs: 2000,
  timedTokens: 60,
  timedMs: 2000,
  vramMb: null,
  ...over,
});

describe("caseMetrics — one test's reading", () => {
  it("counts tok/s over the generation window only, while latency keeps the wait for the first token", () => {
    const m = caseMetrics(measurement({ completionTokens: 60, requestMs: 5000, timedTokens: 60, timedMs: 2000 }));
    expect(m.tokensPerSecond).toBe(30);
    expect(m.latencyMs).toBe(5000);
  });

  it("rounds a memory reading and clamps reasoning to the completion count", () => {
    const m = caseMetrics(measurement({ reasoningTokens: 999, vramMb: 8123.7 }));
    expect(m.tokens.reasoning).toBe(60);
    expect(m.vramMb).toBe(8124);
  });
});

describe("runMetrics — per-case readings → run-level aggregate", () => {
  it("sums tokens and request time, takes throughput over the generation windows, and means the per-case readings", () => {
    const cases = [
      measurement({ completionTokens: 60, reasoningTokens: 20, requestMs: 3000, timedTokens: 60, timedMs: 2000 }),
      measurement({ completionTokens: 90, reasoningTokens: 30, requestMs: 4000, timedTokens: 90, timedMs: 3000 }),
    ].map(caseMetrics);
    const m = runMetrics(cases, memoryFixture);
    expect(m.tokens).toEqual({ prompt: 40, completion: 150, reasoning: 50, total: 190 });
    expect(m.tokensPerSecond).toBe(30);
    expect(m.latencyMs).toBe(7000);
    expect(m.avgTokensPerSecond).toBe(30);
    expect(m.avgCompletionTokens).toBe(75);
    expect(m.avgReasoningTokens).toBe(25);
    expect(m.vramMb).toBe(14681);
    expect(m.memory).toEqual(memoryFixture);
  });

  it("means tok/s over the cases it could time", () => {
    const cases = [measurement({ timedTokens: 60, timedMs: 2000 }), measurement({ timedTokens: 0, timedMs: 0 })];
    expect(runMetrics(cases.map(caseMetrics), null).avgTokensPerSecond).toBe(30);
  });

  it("no cases → all zeros, never NaN", () => {
    const m = runMetrics([], null);
    expect(m.tokensPerSecond).toBe(0);
    expect(m.avgTokensPerSecond).toBe(0);
    expect(Number.isNaN(m.avgCompletionTokens)).toBe(false);
  });
});

describe("mergeMemory — a resumed run's memory over its sessions", () => {
  it("weights each session's average by its samples and keeps the higher peak, unless the readings differ in kind", () => {
    const earlier: MemoryUsage = { ...memoryFixture, peakMb: 1000, avgMb: 900, samples: 3 };
    const later: MemoryUsage = { ...memoryFixture, peakMb: 1200, avgMb: 1000, samples: 1 };
    const elsewhere: MemoryUsage = { ...later, kind: "unified-ram", source: "process rss" };

    expect(mergeMemory(earlier, later)).toEqual({ ...memoryFixture, peakMb: 1200, avgMb: 925, samples: 4 });
    expect(mergeMemory(earlier, elsewhere)).toEqual(elsewhere);
  });
});

describe("reasoningTagChars — inline reasoning fallback", () => {
  it("counts closed and dangling (truncated) think-block content, not the answer", () => {
    expect(reasoningTagChars(`<think>${"x".repeat(40)}</think>the answer <think>${"y".repeat(20)}`)).toBe(60);
    expect(reasoningTagChars("just the answer, no thinking")).toBe(0);
  });
});
