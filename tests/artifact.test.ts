import { describe, expect, it } from "vitest";
import { suiteFingerprint } from "../src/engine/artifact";
import type { Suite, TestCase } from "../src/engine/suite";

const SAMPLE_CASE: Extract<TestCase, { graderKind: "exact" }> = {
  id: "c1",
  category: "sanity",
  tier: 1,
  graderKind: "exact",
  prompt: { system: "be terse", user: "What is 17 * 23?" },
  expected: "391",
};

function sampleSuite(cases: TestCase[] = [SAMPLE_CASE]): Suite {
  return {
    id: "sample-exact",
    version: "v1",
    categories: [
      {
        slug: "sanity",
        label: "Sanity",
        short: "SANITY",
        generation: {
          reasoningTokens: 2048,
          reasoningEffort: "medium",
          maxOutputTokens: 4096,
        },
      },
    ],
    cases,
  };
}

describe("suite fingerprint — proves the suite without disclosing it", () => {
  it("hashes each case's grading content, so authored tier metadata leaves case hashes alone", () => {
    const retiered = sampleSuite([{ ...SAMPLE_CASE, tier: 3 }]);
    const regraded = sampleSuite([{ ...SAMPLE_CASE, expected: "392" }]);

    expect(suiteFingerprint(retiered).caseHashes).toEqual(suiteFingerprint(sampleSuite()).caseHashes);
    expect(suiteFingerprint(regraded).caseHashes).not.toEqual(suiteFingerprint(sampleSuite()).caseHashes);
  });
});
