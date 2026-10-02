import { canonicalize } from "../canonical";
import { applyEditBlocks } from "../code-edits";
import { runCodeTests } from "../code-tests";
import { extractCode } from "../extract";
import type { UnitTestSpec } from "../suite";
import { assertion, failedGate, FULL_QUALITY, previewJson, type Grading } from "./verdict";

const CODE_COMPILES = "code-compiles";
const EDITS_APPLY = "edits-apply";

export async function gradeUnitTest(spec: UnitTestSpec, output: string): Promise<Grading> {
  if (spec.editFile === undefined) return runUnitTests(spec, extractCode(output));
  const edited = applyEditBlocks(spec.editFile, output);
  if (!edited.ok) return failedGate(EDITS_APPLY, edited.error, testNames(spec), "the edits did not apply");
  const tests = await runUnitTests(spec, edited.code);
  return { ...tests, assertions: [assertion(EDITS_APPLY, true), ...tests.assertions] };
}

async function runUnitTests(spec: UnitTestSpec, code: string): Promise<Grading> {
  const run = await runCodeTests(spec, code);
  if (run.compileError !== undefined) {
    return failedGate(CODE_COMPILES, run.compileError, testNames(spec), "code did not compile");
  }
  const assertions = spec.cases.map((c, i) => {
    const outcome = run.outcomes[i];
    if (!outcome.ok) return assertion(`test:${c.name}`, false, `threw: ${outcome.error}`);
    return assertion(
      `test:${c.name}`,
      canonicalize(outcome.value) === canonicalize(c.expected),
      `got ${previewJson(outcome.value)}, want ${previewJson(c.expected)}`,
    );
  });
  const passed = assertions.filter((a) => a.passed).length;
  return {
    correctness: passed / spec.cases.length,
    quality: FULL_QUALITY,
    assertions: [assertion(CODE_COMPILES, true), ...assertions],
  };
}

function testNames(spec: UnitTestSpec): string[] {
  return spec.cases.map((c) => `test:${c.name}`);
}
