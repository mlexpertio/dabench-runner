import type { Suite, TestCase } from "./suite";

export interface SelectedCase {
  testCase: TestCase;
  suiteIndex: number;
}

export function selectCases(suite: Suite, categories: readonly string[] | undefined): SelectedCase[] {
  const all = suite.cases.map((testCase, suiteIndex) => ({ testCase, suiteIndex }));
  if (categories === undefined) return all;

  const declared = suite.categories.map((category) => category.slug);
  const unknown = categories.filter((category) => !declared.includes(category));
  if (unknown.length > 0) {
    throw new Error(
      `unknown categor${unknown.length === 1 ? "y" : "ies"} ${unknown.join(", ")}. Available: ${declared.join(", ")}`,
    );
  }

  return all.filter(({ testCase }) => categories.includes(testCase.category));
}
