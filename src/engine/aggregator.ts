import type { CaseResult, CategoryScore } from "./schema";

export function isPassed(result: Pick<CaseResult, "correctness">): boolean {
  return result.correctness >= 1;
}

export function aggregate(
  caseResults: Pick<CaseResult, "category" | "score" | "correctness">[],
  order: readonly string[],
): CategoryScore[] {
  return order.flatMap((category) => {
    const results = caseResults.filter((result) => result.category === category);
    if (results.length === 0) return [];
    return [
      {
        category,
        score: composite(results),
        caseCount: results.length,
        passRate: results.filter(isPassed).length / results.length,
      },
    ];
  });
}

export function composite(scores: Pick<CategoryScore, "score">[]): number {
  if (scores.length === 0) return 0;
  return Math.round(scores.reduce((sum, s) => sum + s.score, 0) / scores.length);
}
