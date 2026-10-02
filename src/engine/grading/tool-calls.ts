import { canonicalize } from "../canonical";
import { callArguments, type ToolCall } from "../client";
import type { ToolCallRecord } from "../schema";
import { DEFAULT_TOOL_TRACE_OPTIONS, type ToolTraceCase, type ToolTraceOptions } from "../suite";
import { callMatches, isDeepSubset } from "../tool-match";
import { withReplyChecks } from "./rubric";
import { assertion, failedGate, FULL_QUALITY, previewJson, WIDE_PREVIEW_CHARS, type Grading } from "./verdict";

const TOOL_CALLS_MADE = "tool-calls-made";
const CALL_COUNT = "call-count";

export function gradeToolCase(testCase: ToolTraceCase, answer: string, toolCalls: ToolCall[] | undefined): Grading {
  const trace = gradeTooltrace(testCase.expectedTools, testCase.toolOptions ?? DEFAULT_TOOL_TRACE_OPTIONS, toolCalls);
  return withReplyChecks(withForbiddenCalls(trace, testCase.forbiddenCalls, toolCalls), testCase.reply, answer);
}

function gradeTooltrace(
  expected: ToolCallRecord[],
  options: ToolTraceOptions,
  actual: ToolCallRecord[] | undefined,
): Grading {
  if (expected.length === 0) return gradeNoCall(actual ?? []);
  if (!actual || actual.length === 0) {
    return failedGate(
      TOOL_CALLS_MADE,
      "no native tool calls in the response",
      expected.map((e, i) => callName(e, i)),
      "no tool calls made",
    );
  }
  const assertions = [assertion(TOOL_CALLS_MADE, true)];

  const pairings = matchCallsAligned(expected, actual, options);
  const matched = pairings.filter((i) => i >= 0).length;
  const unmatchedActual = actual.filter((_, i) => !pairings.includes(i));

  expected.forEach((e, i) => {
    assertions.push(assertion(callName(e, i), pairings[i] >= 0, missDetail(e, unmatchedActual, options)));
  });

  const extra = actual.length - expected.length;
  const countOk = options.allowExtraCalls ? extra >= 0 : extra === 0;
  assertions.push(
    assertion(CALL_COUNT, countOk, extra > 0 ? `${extra} unexpected extra call(s)` : `${-extra} call(s) missing`),
  );

  const denom = options.allowExtraCalls ? expected.length : Math.max(expected.length, actual.length);
  return { correctness: matched / denom, quality: FULL_QUALITY, assertions };
}

function gradeNoCall(actual: ToolCallRecord[]): Grading {
  const passed = actual.length === 0;
  return {
    correctness: passed ? 1 : 0,
    quality: FULL_QUALITY,
    assertions: [assertion(CALL_COUNT, passed, `${actual.length} unexpected extra call(s)`)],
  };
}

function callName(call: ToolCallRecord, index: number): string {
  return `call[${index}] ${call.name}`;
}

function missDetail(expected: ToolCallRecord, unmatched: ToolCallRecord[], options: ToolTraceOptions): string {
  const sameName = unmatched.find((a) => a.name === expected.name);
  if (sameName) return argsDiff(expected.args, sameName.args, options.argumentMatch);
  if (unmatched.length > 0) return `expected "${expected.name}", got "${unmatched[0].name}"`;
  return "missing call";
}

function argsDiff(
  expectedArgs: ToolCallRecord["args"],
  actualArgs: ToolCallRecord["args"],
  argumentMatch: ToolTraceOptions["argumentMatch"],
): string {
  const want = expectedArgs ?? {};
  const got = actualArgs ?? {};
  const shown = (value: unknown) => previewJson(value, WIDE_PREVIEW_CHARS);
  const problems: string[] = [];
  for (const [key, value] of Object.entries(want)) {
    if (!Object.hasOwn(got, key)) {
      problems.push(`${key}: missing, want ${shown(value)}`);
    } else {
      const matches =
        argumentMatch === "exact" ? canonicalize(value) === canonicalize(got[key]) : isDeepSubset(value, got[key]);
      if (!matches) problems.push(`${key}: got ${shown(got[key])}, want ${shown(value)}`);
    }
  }
  if (argumentMatch === "exact") {
    for (const key of Object.keys(got)) {
      if (!Object.hasOwn(want, key)) problems.push(`${key}: unexpected`);
    }
  }
  return problems.length > 0 ? `arguments differ: ${problems.join("; ")}` : "arguments do not match";
}

/** The longest in-order pairing of expected calls to actual ones; -1 marks an expected call left unpaired. */
function matchCallsAligned(expected: ToolCallRecord[], actual: ToolCallRecord[], options: ToolTraceOptions): number[] {
  const matches = (i: number, j: number) => callMatches(expected[i], actual[j], options.argumentMatch);
  const n = expected.length;
  const m = actual.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const paired = matches(i, j) ? 1 + lcs[i + 1][j + 1] : -1;
      lcs[i][j] = Math.max(paired, lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const pairings = new Array<number>(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (matches(i, j) && lcs[i][j] === 1 + lcs[i + 1][j + 1]) {
      pairings[i] = j;
      i++;
      j++;
    } else if (lcs[i][j] === lcs[i + 1][j]) {
      i++;
    } else {
      j++;
    }
  }
  return pairings;
}

function withForbiddenCalls(
  grading: Grading,
  forbidden: ToolCallRecord[] | undefined,
  toolCalls: ToolCall[] | undefined,
): Grading {
  if (!forbidden) return grading;
  const checks = forbidden.map((rule) => {
    const made = toolCalls?.find((call) => callMatches(rule, call));
    return assertion(`forbidden: ${rule.name}`, !made, made && `called with ${callArguments(made)}`);
  });
  return {
    ...grading,
    correctness: checks.every((check) => check.passed) ? grading.correctness : 0,
    assertions: [...grading.assertions, ...checks],
  };
}
