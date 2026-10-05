import { describe, expect, it } from "vitest";
import { reasoningTagChars } from "../src/engine/inline-reasoning";
import { caseMetrics, mergeMemory, recordedOutput, runMetrics } from "../src/engine/metrics";
import type { MemoryUsage } from "../src/engine/schema";

const memoryFixture: MemoryUsage = {
  kind: "vram",
  peakMb: 14680.6,
  avgMb: 14100.25,
  samples: 12,
  source: "nvidia-smi (process)",
};

type CaseMeasurement = Parameters<typeof caseMetrics>[0];

const measured = (over: Partial<CaseMeasurement> = {}) => {
  const measurement: CaseMeasurement = {
    promptTokens: 20,
    completionTokens: 60,
    reasoningTokens: 0,
    requestMs: 2000,
    timedTokens: 60,
    timedMs: 2000,
    vramMb: null,
    ...over,
  };
  return { metrics: caseMetrics(measurement), timed: measurement };
};

describe("runMetrics — per-case readings → run-level aggregate", () => {
  it("sums tokens and request time, pools tok/s over the timed output, and means the cases it could time", () => {
    const m = runMetrics(
      [
        measured({ completionTokens: 60, reasoningTokens: 20, requestMs: 3000, timedTokens: 60, timedMs: 2000 }),
        measured({ completionTokens: 90, reasoningTokens: 30, requestMs: 4000, timedTokens: 90, timedMs: 3000 }),
        measured({ timedTokens: 0, timedMs: 0 }),
      ],
      memoryFixture,
    );
    expect(m.tokens).toEqual({ prompt: 60, completion: 210, reasoning: 50, total: 270 });
    expect(m.tokensPerSecond).toBe(30);
    expect(m.latencyMs).toBe(9000);
    expect(m.avgTokensPerSecond).toBe(30);
    expect(m.avgCompletionTokens).toBe(70);
    expect(m.vramMb).toBe(14681);
    expect(m.memory).toEqual(memoryFixture);
    expect(runMetrics([], null).tokensPerSecond).toBe(0);
  });

  it("keeps a resumed case's own rate", () => {
    const { metrics } = measured({ completionTokens: 90, timedTokens: 30, timedMs: 1000 });
    expect(runMetrics([{ metrics, timed: recordedOutput(metrics) }], null).tokensPerSecond).toBe(30);
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
