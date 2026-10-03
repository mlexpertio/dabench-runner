import { describe, expect, it } from "vitest";
import { executeCase } from "dabench/engine/case-execution";
import { grade } from "dabench/engine/grader";
import { TestCaseSchema } from "dabench/engine/suite";
import { ScriptedClient } from "./scripted-client";

const conversation = {
  id: "edits",
  category: "instructions",
  tier: 2,
  graderKind: "json-match",
  prompt: { user: "Return 1", turns: ["Return 2", "Return 3"] },
  jsonMatch: { expected: 3, expectedTurns: [1, 2], mode: "exact", arrayOrder: "ordered" },
};

describe("conversation checkpoints", () => {
  it("grades every reply from execution, including an incorrect earlier answer", async () => {
    const testCase = TestCaseSchema.parse(conversation);
    const output = await executeCase(new ScriptedClient(["9", "2", "3"]), testCase, {
      model: "witness",
      config: {
        harness: "mock",
        engineVersion: "1",
        quantization: null,
        contextWindow: null,
        temperature: 0,
        mtp: null,
      },
      generation: { reasoningTokens: 4096, reasoningEffort: "high", maxOutputTokens: 12288 },
    });
    expect((await grade(testCase, output)).score).toBe(67);
    expect((await grade(testCase, { text: "3", earlierReplies: ["1", "2"] })).score).toBe(100);
    expect((await grade(testCase, { text: "3" })).score).toBeLessThan(100);
  });
  it("rejects checkpoint counts that do not match the conversation", () => {
    expect(
      TestCaseSchema.safeParse({ ...conversation, jsonMatch: { ...conversation.jsonMatch, expectedTurns: [1] } })
        .success,
    ).toBe(false);
    expect(TestCaseSchema.safeParse({ ...conversation, prompt: { user: "Return 1" } }).success).toBe(false);
  });
});
