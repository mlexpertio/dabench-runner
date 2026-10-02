import { describe, expect, it } from "vitest";
import { apiCost, isClearSplit, localCost, modelMemoryMb, p90, winsNeeded } from "dabench/engine/calc";

const MB_DIGITS = 6;

describe("modelMemoryMb — weights at the quant's bit width, plus runtime overhead", () => {
  it("sizes MXFP4 weights like Q4_K_M", () => {
    expect(modelMemoryMb(32, "MXFP4")).toBeCloseTo(modelMemoryMb(32, "Q4_K_M"), MB_DIGITS);
  });
});

describe("run cost", () => {
  it("bills local runs by GPU time and hosted runs by tokens", () => {
    expect(localCost(3_600_000, { gpuHourlyUsd: 0.5 })).toBe(0.5);
    expect(localCost(1000, { gpuHourlyUsd: 0.5 })).toBe(0.00013889);
    expect(
      apiCost({ promptTokens: 1000, completionTokens: 500 }, { promptUsdPerToken: 1e-6, completionUsdPerToken: 2e-6 }),
    ).toBe(0.002);
  });
});

describe("isClearSplit — one side wins more than half the untied cases with 95% probability", () => {
  it.each([
    [2, 0, false],
    [34, 15, true],
    [20, 18, false],
    [1050, 1050, false],
  ])("%s wins to %s losses is clear: %s", (wins, losses, clear) => {
    expect(isClearSplit(wins, losses)).toBe(clear);
  });
});

describe("winsNeeded", () => {
  it.each([
    [10, 8],
    [100, 59],
  ])("of %s test cases where two models differ, one must win %s to be clearly better", (differing, wins) => {
    expect(winsNeeded(differing)).toBe(wins);
  });
});

describe("p90", () => {
  it("takes the nearest-rank 90th percentile", () => {
    expect(p90([400, 100, 900, 300, 200, 800, 500, 700, 600, 1000])).toBe(900);
    expect(p90([1200, 300, 5000])).toBe(5000);
    expect(p90([250])).toBe(250);
  });
});
