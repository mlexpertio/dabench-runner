import type { ToolCall } from "../client";
import type { ToolStateCase } from "../suite";
import { ToolEnvironment } from "../tool-environment";
import { assertion, FULL_QUALITY, type Grading } from "./verdict";

const TERMINAL_STATE = "terminal-state";

export function gradeToolState(environment: ToolStateCase["environment"], calls: ToolCall[]): Grading {
  const replay = new ToolEnvironment(environment);
  for (const call of calls) replay.answer(call);
  const reached = replay.succeeded();
  return {
    correctness: reached ? 1 : 0,
    quality: FULL_QUALITY,
    assertions: [
      assertion(TERMINAL_STATE, reached, "actions must be valid, within budget, and reach the required state"),
    ],
  };
}
