import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamPhase } from "../src/engine/case-stream";

const ORIGINAL_TTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
const CASE_PROGRESS = {
  index: 1,
  total: 153,
  caseId: "flag-rollout-guardrails-insufficient-sample",
  category: "agents",
  reasoningTokens: 0,
  contentTokens: 8,
  elapsedMs: 1000,
};

describe("CLI case progress", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_TTY) Object.defineProperty(process.stderr, "isTTY", ORIGINAL_TTY);
    else Reflect.deleteProperty(process.stderr, "isTTY");
  });

  it.each([
    [StreamPhase.CallingTools, "calling tools"],
    [StreamPhase.Thinking, "thinking 0 tok"],
    [StreamPhase.Answering, "writing 8 tok"],
  ])("shows %s activity with its appropriate counter", async (phase, activity) => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { createProgressReporter } = await import("../src/cli/progress");

    createProgressReporter().onCaseTick({ ...CASE_PROGRESS, phase });

    expect(write).toHaveBeenCalledWith(expect.stringContaining(` · ${activity} · 1s`));
  });
});
