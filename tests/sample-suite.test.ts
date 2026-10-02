import { describe, expect, it } from "vitest";
import { loadSuite } from "dabench/cli/suite-loader";

const SAMPLE_SUITE_PATH = "suites/sample.suite.json";
const MAX_CASES_PER_CATEGORY = 2;
const CATEGORY_SLUGS = ["agents", "extraction", "coding", "grounding", "instructions", "business-logic", "safety"];

describe("public sample suite", () => {
  it("validates the current categories and caps each one at two cases", () => {
    const suite = loadSuite(SAMPLE_SUITE_PATH);
    const counts = new Map<string, number>();
    for (const testCase of suite.cases) {
      counts.set(testCase.category, (counts.get(testCase.category) ?? 0) + 1);
    }

    expect(suite.categories.map((category) => category.slug)).toEqual(CATEGORY_SLUGS);
    expect(suite.cases).toHaveLength(CATEGORY_SLUGS.length * MAX_CASES_PER_CATEGORY);
    expect(CATEGORY_SLUGS.map((slug) => counts.get(slug))).toEqual(CATEGORY_SLUGS.map(() => MAX_CASES_PER_CATEGORY));
  });

  it("declares arguments for every tool in the runnable examples", () => {
    const suite = loadSuite(SAMPLE_SUITE_PATH);
    const toolCases = suite.cases.filter((testCase) => testCase.graderKind === "tooltrace");

    expect(toolCases.length).toBeGreaterThan(0);
    for (const testCase of toolCases) {
      for (const tool of testCase.tools) {
        expect(tool.parameters?.type).toBe("object");
        expect(tool.parameters?.required?.length).toBeGreaterThan(0);
      }
    }
  });
});
