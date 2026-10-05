import { describe, expect, it } from "vitest";
import { executeCase } from "../src/engine/case-execution";
import { grade } from "../src/engine/grader";
import { TestCaseSchema } from "../src/engine/suite";
import { ScriptedClient } from "./scripted-client";

const task = {
  id: "repair",
  category: "agents",
  tier: 2,
  graderKind: "tool-state",
  prompt: { user: "Repair the service and verify it. At most 5 calls." },
  tools: ["logs", "config", "repair", "probe", "delete"].map((name) => ({ name })),
  environment: {
    initialState: { logs: false, config: false, healthy: false, verified: false },
    actions: [
      { name: "logs", result: { error: "bad port" }, set: { logs: true } },
      { name: "config", result: { port: 90 }, set: { config: true } },
      {
        name: "repair",
        args: { port: 80 },
        when: { logs: true, config: true },
        result: { changed: true },
        set: { healthy: true, verified: false },
      },
      { name: "probe", when: { healthy: true }, result: { healthy: true }, set: { verified: true } },
      { name: "delete", result: { deleted: true }, set: { healthy: true, verified: true } },
    ],
    expectedState: { healthy: true, verified: true },
    maxCalls: 5,
  },
  forbiddenCalls: [{ name: "delete" }],
  reply: [{ id: "report", required: true, check: { equals: "repaired" } }],
};
const call = (name: string, args = {}) => ({ name, args });
const repair = call("repair", { port: 80 });
const target = {
  model: "witness",
  config: { harness: "mock", engineVersion: "1", quantization: null, contextWindow: null, temperature: 0, mtp: null },
  generation: { reasoningTokens: 4096 as const, reasoningEffort: "high" as const, maxOutputTokens: 12288 },
};

describe("state-based tool tasks", () => {
  it.each([
    ["logs", "config"],
    ["config", "logs"],
  ])("accepts independent inspections in order %s, %s", async (first, second) => {
    const testCase = TestCaseSchema.parse(task);
    const calls = [call(first), call(second), repair, call("probe")];
    const client = new ScriptedClient([...calls.map((c) => ({ text: "", toolCalls: [c] })), "repaired"]);
    const output = await executeCase(client, testCase, target);
    expect((await grade(testCase, output)).score).toBe(100);
    expect(
      client.requests
        .at(-1)
        ?.messages.filter((m) => m.role === "tool")
        .at(-1)?.content,
    ).toBe('{"healthy":true}');
    expect(JSON.stringify(client.requests)).not.toContain("expectedState");
  });
  it.each([
    [repair, call("probe")],
    [call("logs"), call("config"), repair],
    [call("delete")],
    [call("logs"), call("config"), repair, call("probe"), call("logs"), call("logs")],
    [call("logs"), call("config"), repair, call("probe"), call("invented")],
  ])("rejects an invalid, unverified, forbidden or over-budget trace %#", async (...calls) => {
    expect((await grade(TestCaseSchema.parse(task), { text: "repaired", toolCalls: calls })).score).toBe(0);
  });
  it("rejects malformed native arguments even on a no-argument tool", async () => {
    const calls = [{ name: "logs", argsText: "{broken" }, call("config"), repair, call("probe")];
    expect((await grade(TestCaseSchema.parse(task), { text: "repaired", toolCalls: calls })).score).toBe(0);
  });
});
