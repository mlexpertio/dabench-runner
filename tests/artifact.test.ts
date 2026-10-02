import { describe, expect, it } from "vitest";
import { suiteFingerprint } from "dabench/engine/artifact";
import { canonicalize } from "dabench/engine/canonical";
import type { Suite, TestCase } from "dabench/engine/suite";

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

describe("canonical hashing", () => {
  it("canonicalizes independent of key insertion order (the hashing invariant)", () => {
    expect(canonicalize({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalize({ b: { d: 3, c: 2 }, a: 1 }));
  });
});

describe("suite fingerprint — proves the suite without disclosing it", () => {
  it("hashes each case's grading content, so authored tier metadata leaves case hashes alone", () => {
    const retiered = sampleSuite([{ ...SAMPLE_CASE, tier: 3 }]);
    const regraded = sampleSuite([{ ...SAMPLE_CASE, expected: "392" }]);

    expect(suiteFingerprint(retiered).caseHashes).toEqual(suiteFingerprint(sampleSuite()).caseHashes);
    expect(suiteFingerprint(regraded).caseHashes).not.toEqual(suiteFingerprint(sampleSuite()).caseHashes);
  });
});
