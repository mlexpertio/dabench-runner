import type { ToolCallRecord } from "../schema";
import type { ToolStateCase } from "../suite";
import { ToolEnvironment } from "../tool-environment";
import { callMatches } from "../tool-match";
import { withReplyChecks } from "./rubric";
import { assertion, FULL_QUALITY, type Grading } from "./verdict";

export function gradeToolState(testCase: ToolStateCase, answer: string, calls: ToolCallRecord[] = []): Grading {
  const environment = new ToolEnvironment(testCase.environment);
  for (const call of calls) environment.answer(call);
  const assertions = [
    assertion(
      "terminal-state",
      environment.succeeded(),
      "actions must be valid, within budget, and reach the required state",
    ),
    ...(testCase.forbiddenCalls ?? []).map((rule) =>
      assertion(`forbidden: ${rule.name}`, !calls.some((call) => callMatches(rule, call))),
    ),
  ];
  return withReplyChecks(
    { correctness: assertions.every((check) => check.passed) ? 1 : 0, quality: FULL_QUALITY, assertions },
    testCase.reply,
    answer,
  );
}
