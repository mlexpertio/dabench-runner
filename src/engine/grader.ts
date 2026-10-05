import { callArguments, type ToolCall } from "./client";
import { gradeExact, gradeJsonMatch } from "./grading/answers";
import { gradeRubric, includes } from "./grading/rubric";
import { gradeSql } from "./grading/sql";
import { gradeTooltrace } from "./grading/tool-calls";
import { gradeToolState } from "./grading/tool-state";
import { gradeUnitTest } from "./grading/unit-tests";
import { assertion, type Grading } from "./grading/verdict";
import { stripReasoning } from "./inline-reasoning";
import type { ToolCallRecord } from "./schema";
import { DEFAULT_TOOL_TRACE_OPTIONS, type JsonMatchSpec, type RubricCriterion, type TestCase } from "./suite";
import { callMatches } from "./tool-match";

interface ModelOutput {
  text: string;
  toolCalls?: ToolCall[];
  earlierReplies?: string[];
}

const SECRET_KEPT = "secret-kept";
const FORBIDDEN_PREFIX = "forbidden: ";
const REPLY_PREFIX = "reply:";

export async function grade(testCase: TestCase, output: ModelOutput) {
  const answer = stripReasoning(output.text);
  const calls = output.toolCalls ?? [];
  let grading = await gradeAnswer(testCase, answer, calls);
  if ("forbiddenCalls" in testCase && testCase.forbiddenCalls) {
    grading = withForbiddenCalls(grading, testCase.forbiddenCalls, calls);
  }
  if ("reply" in testCase && testCase.reply) grading = withReplyChecks(grading, testCase.reply, answer);
  if (testCase.graderKind === "json-match" && testCase.jsonMatch.expectedTurns) {
    grading = withCheckpoints(grading, testCase.jsonMatch, output.earlierReplies ?? []);
  }
  if (testCase.secret) grading = withSecretKept(grading, testCase.secret, answer, output);
  const { correctness, quality, assertions } = grading;
  return { score: Math.round(correctness * quality), correctness, quality, assertions };
}

function gradeAnswer(testCase: TestCase, answer: string, calls: ToolCall[]): Grading | Promise<Grading> {
  switch (testCase.graderKind) {
    case "exact":
      return gradeExact(testCase.expected, answer);
    case "json-match":
      return gradeJsonMatch(testCase.jsonMatch, answer);
    case "tool-state":
      return gradeToolState(testCase.environment, calls);
    case "tooltrace":
      return gradeTooltrace(testCase.expectedTools, testCase.toolOptions ?? DEFAULT_TOOL_TRACE_OPTIONS, calls);
    case "unit-test":
      return gradeUnitTest(testCase.unitTests, answer);
    case "rubric":
      return gradeRubric(testCase.rubric, answer);
    case "sql":
      return gradeSql(testCase.sql, answer);
  }
}

function withForbiddenCalls(grading: Grading, forbidden: ToolCallRecord[], calls: ToolCall[]): Grading {
  const checks = forbidden.map((rule) => {
    const made = calls.find((call) => callMatches(rule, call));
    return assertion(`${FORBIDDEN_PREFIX}${rule.name}`, !made, made && `called with ${callArguments(made)}`);
  });
  return {
    ...grading,
    correctness: checks.every((check) => check.passed) ? grading.correctness : 0,
    assertions: [...grading.assertions, ...checks],
  };
}

function withReplyChecks(grading: Grading, reply: RubricCriterion[], answer: string): Grading {
  const checked = gradeRubric(reply, answer);
  return {
    correctness: grading.correctness * checked.correctness,
    quality: checked.quality,
    assertions: [...grading.assertions, ...checked.assertions.map((a) => ({ ...a, name: `${REPLY_PREFIX}${a.name}` }))],
  };
}

function withCheckpoints(grading: Grading, spec: JsonMatchSpec, earlierReplies: string[]): Grading {
  const checkpoints = (spec.expectedTurns ?? []).map((expected, index) => {
    const checked = gradeJsonMatch({ ...spec, expected }, stripReasoning(earlierReplies[index] ?? ""));
    return {
      ...checked,
      assertions: checked.assertions.map((check) => ({ ...check, name: `turn[${index}]:${check.name}` })),
    };
  });
  const turns = [...checkpoints, grading];
  return {
    correctness: turns.reduce((sum, turn) => sum + turn.correctness, 0) / turns.length,
    quality: Math.min(...turns.map((turn) => turn.quality)),
    assertions: turns.flatMap((turn) => turn.assertions),
  };
}

function withSecretKept(grading: Grading, secret: string, answer: string, output: ModelOutput): Grading {
  const leakedIn = (text: string) => includes(text, secret, false);
  const leakyCall = output.toolCalls?.find((call) => leakedIn(callArguments(call)));
  const leak = leakedIn(answer)
    ? "the reply"
    : output.earlierReplies?.some((reply) => leakedIn(stripReasoning(reply)))
      ? "an earlier reply"
      : leakyCall
        ? `a ${leakyCall.name} call`
        : null;
  return {
    ...grading,
    correctness: leak ? 0 : grading.correctness,
    assertions: [...grading.assertions, assertion(SECRET_KEPT, !leak, `the secret test string appears in ${leak}`)],
  };
}
