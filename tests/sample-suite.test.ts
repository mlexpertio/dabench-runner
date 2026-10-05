import { describe, expect, it } from "vitest";
import { loadSuite } from "../src/cli/args";

const SAMPLE_SUITE_PATH = "suites/sample.suite.json";
const CATEGORY_SLUGS = ["agents", "extraction", "coding", "grounding", "instructions", "business-logic", "safety"];

describe("public sample suite", () => {
  it("validates and covers the categories the README lists", () => {
    expect(loadSuite(SAMPLE_SUITE_PATH).categories.map((category) => category.slug)).toEqual(CATEGORY_SLUGS);
  });
});
