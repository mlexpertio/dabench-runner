import type { CaseResult, CategoryScore } from "./schema";

export function isPassed(result: Pick<CaseResult, "correctness">): boolean {
  return result.correctness >= 1;
}

function groupInOrder<T>(items: Iterable<T>, keyOf: (item: T) => string, order: readonly string[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const rank = new Map(order.map((key, index) => [key, index]));
  const rankOf = (key: string) => rank.get(key) ?? order.length;
  return [...groups].sort(([a], [b]) => rankOf(a) - rankOf(b));
}

export function aggregate(
  caseResults: Pick<CaseResult, "category" | "score" | "correctness">[],
  order: readonly string[],
): CategoryScore[] {
  return groupInOrder(caseResults, (r) => r.category, order).map(([category, results]) => ({
    category,
    score: composite(results),
    caseCount: results.length,
    passRate: results.filter(isPassed).length / results.length,
  }));
}

export function composite(scores: Pick<CategoryScore, "score">[]): number {
  if (scores.length === 0) return 0;
  return Math.round(scores.reduce((sum, s) => sum + s.score, 0) / scores.length);
}
