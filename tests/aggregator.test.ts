import { describe, expect, it } from "vitest";
import { aggregate, composite } from "dabench/engine/aggregator";
import type { CaseResult, CategoryScore } from "dabench/engine/schema";

function caseResult(caseId: string, category: string, score: number): CaseResult {
  return {
    caseId,
    category,
    graderKind: "exact",
    score,
    correctness: score / 100,
    quality: 100,
    assertions: [],
    response: "",
    finishReason: "stop",
    metrics: {
      tokens: { prompt: 0, completion: 0, reasoning: 0, total: 0 },
      tokensPerSecond: 0,
      latencyMs: 0,
      vramMb: null,
    },
  };
}

const cat = (category: string, score: number, caseCount = 1): CategoryScore => ({
  category,
  score,
  caseCount,
  passRate: score >= 100 ? 1 : 0,
});

describe("aggregate — per-case results → per-category scores", () => {
  it("means the case scores within each category, counts them, and passes only fully-correct cases", () => {
    const out = aggregate(
      [caseResult("a", "coding", 100), caseResult("b", "coding", 60), caseResult("c", "rag-context", 80)],
      ["coding", "rag-context"],
    );
    const coding = out.find((c) => c.category === "coding")!;
    const rag = out.find((c) => c.category === "rag-context")!;
    expect(coding).toEqual({ category: "coding", score: 80, caseCount: 2, passRate: 0.5 });
    expect(rag).toEqual({ category: "rag-context", score: 80, caseCount: 1, passRate: 0 });
  });
});

describe("composite — category scores → one overall score", () => {
  it("means every reported category equally, even unregistered ones, and is 0 with none", () => {
    const scores = [cat("rag-context", 90), cat("coding", 60), cat("my-custom-eval", 30)];
    expect(composite(scores)).toBe(60);
    expect(composite([])).toBe(0);
  });
});
