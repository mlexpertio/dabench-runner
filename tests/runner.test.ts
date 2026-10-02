import { describe, expect, it } from "vitest";
import type { RunIdentity } from "dabench/engine/artifact";
import { selectCases } from "dabench/engine/case-selection";
import type { CompletionClient } from "dabench/engine/client";
import type { MemoryMonitor } from "dabench/engine/memory";
import { OpenAICompletionClient } from "dabench/engine/openai-client";
import { runBenchmark } from "dabench/engine/runner";
import type { Artifact, Hardware, MemoryUsage, ModelConfig, ModelRef } from "dabench/engine/schema";
import { SuiteSchema, type Suite } from "dabench/engine/suite";
import { testIdentity } from "./run-identity";
import { ScriptedClient, sseResponse, type ScriptedReply } from "./scripted-client";

const BALANCED_GENERATION = {
  reasoningTokens: 2048,
  reasoningEffort: "medium",
  maxOutputTokens: 4096,
} as const;
const DEEP_GENERATION = {
  reasoningTokens: 4096,
  reasoningEffort: "high",
  maxOutputTokens: 8192,
} as const;

const ARITHMETIC = { slug: "arithmetic", label: "Arithmetic", short: "ARITH", generation: DEEP_GENERATION };
const STRUCTURED = {
  slug: "structured-output",
  label: "Structured Output",
  short: "STRUCT",
  generation: BALANCED_GENERATION,
};
const TOOL_CALLING = { slug: "tool-calling", label: "Tool Calling", short: "TOOL", generation: DEEP_GENERATION };
const CODING = { slug: "coding", label: "Coding", short: "CODE", generation: DEEP_GENERATION };
const WRITING = { slug: "writing", label: "Writing", short: "WRITE", generation: BALANCED_GENERATION };
const SQL = { slug: "sql", label: "SQL", short: "SQL", generation: BALANCED_GENERATION };

function oneCaseSuite(category: { slug: string }, testCase: Record<string, unknown>): Suite {
  return SuiteSchema.parse({
    id: category.slug,
    version: "v1",
    categories: [category],
    cases: [{ id: "case1", category: category.slug, tier: 1, ...testCase }],
  });
}

function mixedSuite(): Suite {
  return SuiteSchema.parse({
    id: "runner-mixed",
    version: "v1",
    categories: [ARITHMETIC, STRUCTURED, TOOL_CALLING, CODING, WRITING],
    cases: [
      { id: "e1", category: "arithmetic", tier: 1, graderKind: "exact", prompt: { user: "17*23?" }, expected: "391" },
      { id: "n1", category: "arithmetic", tier: 1, graderKind: "exact", prompt: { user: "1/4?" }, expected: "0.25" },
      {
        id: "m1",
        category: "structured-output",
        tier: 1,
        graderKind: "json-match",
        prompt: { user: "answer json" },
        jsonMatch: { expected: { answer: 42 }, mode: "exact", arrayOrder: "ordered" },
      },
      {
        id: "s1",
        category: "structured-output",
        tier: 1,
        graderKind: "schema",
        prompt: { user: "person json" },
        schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      },
      {
        id: "t1",
        category: "tool-calling",
        tier: 1,
        graderKind: "tooltrace",
        prompt: { user: "call search" },
        tools: [
          { name: "search", parameters: { type: "object", required: ["q"], properties: { q: { type: "string" } } } },
        ],
        expectedTools: [{ name: "search", args: { q: "sofia" } }],
      },
      {
        id: "c1",
        category: "coding",
        tier: 1,
        graderKind: "unit-test",
        prompt: { user: "write add" },
        unitTests: { entry: "add", cases: [{ name: "a", args: [2, 3], expected: 5 }] },
      },
      {
        id: "r1",
        category: "writing",
        tier: 1,
        graderKind: "rubric",
        prompt: { user: "recommend" },
        rubric: [{ id: "cites", required: true, weight: 1, check: { contains: "RAG" } }],
      },
    ],
  });
}

const RESPONSES: ScriptedReply[] = [
  "391",
  "0.25",
  '{"answer":42}',
  '{"name":"Ada"}',
  { text: "", toolCalls: [{ id: "call_1", name: "search", args: { q: "sofia" } }] },
  "done searching",
  "function add(a,b){return a+b}",
  "For RAG, use a quantized 14B model.",
];

const EXPECTED_RESPONSES = [
  "391",
  "0.25",
  '{"answer":42}',
  '{"name":"Ada"}',
  '[{"name":"search","arguments":{"q":"sofia"}}]\n\ndone searching',
  "function add(a,b){return a+b}",
  "For RAG, use a quantized 14B model.",
];

const model: ModelRef = { id: "mock/oracle", name: "Mock Oracle", provider: "qwen" };
const config: ModelConfig = {
  harness: "mock",
  engineVersion: "0.1.0",
  quantization: "Q4_K_M",
  contextWindow: 32768,
  temperature: 0,
  mtp: null,
};

const PRICING = { promptUsdPerToken: 1e-6, completionUsdPerToken: 2e-6 };

function identity(suite: Suite, overrides: Partial<RunIdentity> = {}): RunIdentity {
  return testIdentity({ suite, model, config, ...overrides });
}

type BenchmarkOptions = Parameters<typeof runBenchmark>[0];

function benchmark(suite: Suite, client: CompletionClient, options: Partial<BenchmarkOptions> = {}) {
  return runBenchmark({
    identity: identity(suite),
    client,
    cost: null,
    cases: selectCases(suite, undefined),
    ...options,
  });
}

const usage = { promptTokens: 10, completionTokens: 5 };

describe("BenchmarkRunner — interactive tool loop", () => {
  const alertSuite = (extra: Record<string, unknown> = {}) =>
    oneCaseSuite(TOOL_CALLING, {
      graderKind: "tooltrace",
      prompt: { user: "Acknowledge the active alert." },
      tools: [
        { name: "list_alerts", parameters: { type: "object", properties: {} } },
        {
          name: "ack_alert",
          parameters: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
        },
      ],
      toolResults: [{ name: "list_alerts", result: { alerts: [{ id: 7, status: "active" }] } }],
      expectedTools: [{ name: "list_alerts" }, { name: "ack_alert", args: { id: 7 } }],
      ...extra,
    });

  it("offers tools natively, feeds canned results back, and grades the accumulated trace", async () => {
    const client = new ScriptedClient([
      {
        text: "<think>list them first</think>Checking the alerts.",
        toolCalls: [{ id: "c1", name: "list_alerts", args: {} }],
        usage,
        finishReason: "tool_calls",
      },
      { text: "", toolCalls: [{ id: "c2", name: "ack_alert", args: { id: 7 } }], usage, finishReason: "tool_calls" },
      { text: "Alert 7 acknowledged.", usage, finishReason: "stop" },
    ]);

    const body = await benchmark(alertSuite(), client);

    const result = body.caseResults[0];
    expect(result.score).toBe(100);
    expect(result.toolCalls).toEqual([
      { name: "list_alerts", args: {} },
      { name: "ack_alert", args: { id: 7 } },
    ]);

    expect(client.requests).toHaveLength(3);
    expect(client.requests.map((request) => request.providerParameters?.max_tokens)).toEqual([8192, 8192, 8192]);
    expect(client.requests[0].tools?.map((tool) => tool.name)).toEqual(["list_alerts", "ack_alert"]);
    const secondTurn = client.requests[1].messages;
    expect(secondTurn.at(-2)).toMatchObject({
      role: "assistant",
      content: "Checking the alerts.",
      toolCalls: [{ id: "c1", name: "list_alerts" }],
    });
    expect(secondTurn.at(-1)).toEqual({
      role: "tool",
      toolCallId: "c1",
      content: JSON.stringify({ alerts: [{ id: 7, status: "active" }] }),
    });

    expect(result.metrics.tokens.prompt).toBe(30);
    expect(result.metrics.tokens.completion).toBe(15);
  });

  it("fails the secret check when the secret leaks in a reply sent alongside a tool call", async () => {
    const client = new ScriptedClient([
      { text: "The key is KST-4471-ORCHID.", toolCalls: [{ id: "c1", name: "list_alerts", args: {} }], usage },
      { text: "", toolCalls: [{ id: "c2", name: "ack_alert", args: { id: 7 } }], usage, finishReason: "tool_calls" },
      { text: "Alert 7 acknowledged.", usage, finishReason: "stop" },
    ]);

    const body = await benchmark(alertSuite({ secret: "KST-4471-ORCHID" }), client);

    expect(body.caseResults[0].correctness).toBe(0);
    expect(body.caseResults[0].assertions).toContainEqual({
      name: "secret-kept",
      passed: false,
      detail: "the secret test string appears in an earlier reply",
    });
  });

  async function runScripted(suite: Suite, script: ScriptedReply[]) {
    const client = new ScriptedClient(script);
    const body = await benchmark(suite, client);
    const toolReplies = client.requests
      .at(-1)!
      .messages.filter((m) => m.role === "tool")
      .map((m) => m.content);
    return { result: body.caseResults[0], toolReplies };
  }

  it("serves a once-only error result first, then the next match on retry", async () => {
    const sendParams = { type: "object", required: ["to"], properties: { to: { type: "string" } } };
    const { result, toolReplies } = await runScripted(
      oneCaseSuite(TOOL_CALLING, {
        graderKind: "tooltrace",
        prompt: { user: "Email the report to ops." },
        tools: [{ name: "send_email", parameters: sendParams }],
        toolResults: [
          { name: "send_email", once: true, result: { error: { code: 503, message: "try again" } } },
          { name: "send_email", result: { sent: true, id: "m-1" } },
        ],
        expectedTools: [
          { name: "send_email", args: { to: "ops" } },
          { name: "send_email", args: { to: "ops" } },
        ],
      }),
      [
        { text: "", toolCalls: [{ id: "c1", name: "send_email", args: { to: "ops" } }], usage },
        { text: "", toolCalls: [{ id: "c2", name: "send_email", args: { to: "ops" } }], usage },
        { text: "Sent.", usage },
      ],
    );

    expect(toolReplies).toEqual([
      JSON.stringify({ error: { code: 503, message: "try again" } }),
      JSON.stringify({ sent: true, id: "m-1" }),
    ]);
    expect(result.score).toBe(100);
  });

  it("feeds each call the result matched on its arguments, so a chain can use an earlier result", async () => {
    const byEmail = { type: "object", required: ["email"], properties: { email: { type: "string" } } };
    const byCustomer = { type: "object", required: ["customer_id"], properties: { customer_id: { type: "string" } } };
    const { result, toolReplies } = await runScripted(
      oneCaseSuite(TOOL_CALLING, {
        graderKind: "tooltrace",
        prompt: { user: "List orders for ana@example.com." },
        tools: [
          { name: "find_customer", parameters: byEmail },
          { name: "list_orders", parameters: byCustomer },
        ],
        toolResults: [
          { name: "find_customer", args: { email: "ana@example.com" }, result: { customer_id: "C-88" } },
          { name: "list_orders", args: { customer_id: "C-88" }, result: { orders: ["O-1", "O-2"] } },
          { name: "list_orders", result: { error: "customer not found" } },
        ],
        expectedTools: [
          { name: "find_customer", args: { email: "ana@example.com" } },
          { name: "list_orders", args: { customer_id: "C-88" } },
        ],
      }),
      [
        { text: "", toolCalls: [{ id: "c1", name: "list_orders", args: { customer_id: "ana" } }], usage },
        { text: "", toolCalls: [{ id: "c2", name: "find_customer", args: { email: "ana@example.com" } }], usage },
        { text: "", toolCalls: [{ id: "c3", name: "list_orders", args: { customer_id: "C-88" } }], usage },
        { text: "O-1 and O-2.", usage },
      ],
    );

    expect(toolReplies).toEqual([
      JSON.stringify({ error: "customer not found" }),
      JSON.stringify({ customer_id: "C-88" }),
      JSON.stringify({ orders: ["O-1", "O-2"] }),
    ]);
    expect(result.score).toBe(67);
  });

  it("acknowledges unscripted calls with a plain ack, pairs each with a generated id, and stops at maxTurns", async () => {
    const looping = oneCaseSuite(TOOL_CALLING, {
      graderKind: "tooltrace",
      prompt: { user: "poll" },
      tools: [{ name: "poll", parameters: { type: "object", properties: {} } }],
      toolOptions: { order: "strict", allowExtraCalls: false, argumentMatch: "subset", maxTurns: 3 },
      expectedTools: [{ name: "poll" }],
    });
    const client = new ScriptedClient([{ text: "", toolCalls: [{ name: "poll" }], usage, finishReason: "tool_calls" }]);

    const body = await benchmark(looping, client);

    expect(client.requests).toHaveLength(3);
    expect(client.requests[1].messages.at(-1)).toMatchObject({ role: "tool", content: JSON.stringify({ ok: true }) });
    const history = client.requests[2].messages;
    const callIds = history.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []).map((call) => call.id) : []));
    const replyIds = history.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : []));
    expect(replyIds).toEqual(callIds);
    expect(new Set(callIds).size).toBe(2);
    expect(callIds.every(Boolean)).toBe(true);
    expect(body.caseResults[0].toolCalls).toHaveLength(3);
    expect(body.caseResults[0].score).toBeLessThan(100);
  });
});

describe("BenchmarkRunner — scripted multi-turn conversations", () => {
  it("sends each scripted turn after the model's previous reply and grades the last reply", async () => {
    const suite = oneCaseSuite(WRITING, {
      graderKind: "rubric",
      prompt: {
        system: "Answer in at most 12 words.",
        user: "Draft a status line for the outage.",
        turns: ["Correction: it was the EU region, not US.", "Now add that it's resolved."],
      },
      rubric: [{ id: "eu-resolved", required: true, check: { containsAll: ["EU", "resolved"] } }],
    });
    const client = new ScriptedClient([
      { text: "US outage under investigation.", usage, finishReason: "stop" },
      { text: "<think>fix region</think>EU outage under investigation.", usage, finishReason: "stop" },
      { text: "EU outage resolved.", usage, finishReason: "stop" },
    ]);

    const body = await benchmark(suite, client);

    expect(client.requests).toHaveLength(3);
    expect(client.requests[2].messages).toEqual([
      { role: "system", content: "Answer in at most 12 words." },
      { role: "user", content: "Draft a status line for the outage." },
      { role: "assistant", content: "US outage under investigation." },
      { role: "user", content: "Correction: it was the EU region, not US." },
      { role: "assistant", content: "EU outage under investigation." },
      { role: "user", content: "Now add that it's resolved." },
    ]);
    expect(body.caseResults[0]).toMatchObject({ response: "EU outage resolved.", score: 100 });
    expect(body.caseResults[0].metrics.tokens).toMatchObject({ prompt: 30, completion: 15 });
  });
});

describe("BenchmarkRunner — SQL prompts", () => {
  it("shows the schema and keeps the seed rows hidden", async () => {
    const suite = oneCaseSuite(SQL, {
      graderKind: "sql",
      prompt: { user: "How many orders?" },
      sql: {
        schema: "CREATE TABLE orders (id INTEGER PRIMARY KEY);",
        seed: "INSERT INTO orders VALUES (41);",
        expected: [[1]],
      },
    });
    const client = new ScriptedClient([{ text: "SELECT COUNT(*) FROM orders", usage, finishReason: "stop" }]);

    const body = await benchmark(suite, client);

    const user = client.requests[0].messages.at(-1)?.content as string;
    expect(user).toContain("CREATE TABLE orders (id INTEGER PRIMARY KEY);");
    expect(user).not.toContain("INSERT");
    expect(body.caseResults[0].score).toBe(100);
  });
});

describe("BenchmarkRunner — resumable checkpoints", () => {
  it("runs selected categories and later skips their recorded cases", async () => {
    const suite = mixedSuite();
    const progress: Array<{ index: number; total: number; caseId: string }> = [];
    const suiteIndexes: number[] = [];
    let firstClock = 0;
    const structured = await benchmark(suite, new ScriptedClient(RESPONSES.slice(2, 4)), {
      cases: selectCases(suite, ["structured-output"]),
      clock: () => (firstClock += 1000),
      onProgress: ({ index, total, caseId }) => progress.push({ index, total, caseId }),
      onCheckpoint: (_artifact, completed) => {
        suiteIndexes.push(completed.suiteIndex);
      },
    });

    expect(progress).toEqual([
      { index: 1, total: 2, caseId: "m1" },
      { index: 2, total: 2, caseId: "s1" },
    ]);
    expect(suiteIndexes).toEqual([2, 3]);
    expect(structured.caseResults.map((result) => result.caseId)).toEqual(["m1", "s1"]);
    expect(structured.categoryScores.map((score) => score.category)).toEqual(["structured-output"]);
    expect(structured.categories).toEqual(suite.categories);
    expect(structured.reproduce.caseHashes).toHaveLength(suite.cases.length);

    let secondClock = 0;
    const extended = await benchmark(suite, new ScriptedClient(RESPONSES.slice(0, 2)), {
      cases: selectCases(suite, ["arithmetic"]),
      resumeFrom: structured,
      clock: () => (secondClock += 1000),
    });

    expect(extended.runId).toBe(structured.runId);
    expect(extended.caseResults.map((result) => result.caseId)).toEqual(["e1", "n1", "m1", "s1"]);
    expect(extended.categoryScores.map((score) => score.category)).toEqual(["arithmetic", "structured-output"]);

    const noCalls = new ScriptedClient([]);
    const checkpoints: string[] = [];
    const unchanged = await benchmark(suite, noCalls, {
      cases: selectCases(suite, ["structured-output"]),
      resumeFrom: extended,
      onCheckpoint: (_artifact, completed) => {
        checkpoints.push(completed.result.caseId);
      },
    });

    expect(noCalls.requests).toHaveLength(0);
    expect(checkpoints).toEqual([]);
    expect(unchanged.caseResults).toEqual(extended.caseResults);
  });

  it("reuses completed results and runs only the missing cases", async () => {
    let checkpoint: Awaited<ReturnType<typeof runBenchmark>> | undefined;
    const runIds = new Set<string>();
    let firstClock = 0;

    await expect(
      benchmark(mixedSuite(), new ScriptedClient(RESPONSES), {
        cost: PRICING,
        clock: () => (firstClock += 1000),
        onCheckpoint: (artifact) => {
          checkpoint = artifact;
          runIds.add(artifact.runId);
          if (artifact.caseResults.length === 3) throw new Error("simulated interruption");
        },
      }),
    ).rejects.toThrow("simulated interruption");

    expect(checkpoint).toBeDefined();
    expect(runIds.size).toBe(1);
    expect(checkpoint?.caseResults.map((result) => result.caseId)).toEqual(["e1", "n1", "m1"]);

    const checkpointSizes: number[] = [];
    let resumeClock = 0;
    const resumed = await benchmark(mixedSuite(), new ScriptedClient(RESPONSES.slice(3)), {
      cost: PRICING,
      resumeFrom: checkpoint!,
      clock: () => (resumeClock += 1000),
      onCheckpoint: (artifact) => {
        checkpointSizes.push(artifact.caseResults.length);
      },
    });

    expect(checkpointSizes).toEqual([4, 5, 6, 7]);
    expect(resumed.runId).toBe(checkpoint?.runId);
    expect(resumed.run.timestamp).toBe(new Date(0).toISOString());
    expect(resumed.caseResults.map((result) => result.caseId)).toEqual(
      mixedSuite().cases.map((testCase) => testCase.id),
    );
    expect(resumed.caseResults.map((result) => result.response)).toEqual(EXPECTED_RESPONSES);
    expect(resumed.caseResults.every((result) => result.score === 100)).toBe(true);
  });
});

describe("BenchmarkRunner — run totals", () => {
  const REQUEST_MS = 2000;
  const USAGE = { promptTokens: 1000, completionTokens: 500 };
  const CASE_COST_USD = 0.002;

  function pricedRun(categories: string[], resumeFrom?: Artifact) {
    let now = 0;
    const client: CompletionClient = {
      async stream() {
        now += REQUEST_MS;
        return { text: "391", usage: USAGE, aborted: false };
      },
    };
    const suite = mixedSuite();
    return benchmark(suite, client, {
      cost: PRICING,
      cases: selectCases(suite, categories),
      resumeFrom,
      clock: () => now,
    });
  }

  it("prices a hosted run's tokens and sums its request time, counting the cases a resume reused", async () => {
    const first = await pricedRun(["arithmetic"]);
    expect(first.cost).toEqual({ amountUsd: 2 * CASE_COST_USD, currency: "USD", estimated: false });
    expect(first.metrics.latencyMs).toBe(2 * REQUEST_MS);

    const resumed = await pricedRun(["structured-output"], first);
    expect(resumed.cost).toEqual({ amountUsd: 4 * CASE_COST_USD, currency: "USD", estimated: false });
    expect(resumed.metrics.latencyMs).toBe(4 * REQUEST_MS);
    expect(resumed.metrics.tokens.total).toBe(4 * (USAGE.promptTokens + USAGE.completionTokens));
  });
});

describe("BenchmarkRunner — reasoning token accounting", () => {
  const exactCase = (id: string) => ({
    id,
    category: "arithmetic",
    tier: 1,
    graderKind: "exact",
    prompt: { user: id },
    expected: "42",
  });
  const toolLoopCase = (id: string) => ({
    id,
    category: "tool-calling",
    tier: 1,
    graderKind: "tooltrace",
    prompt: { user: "call f" },
    tools: [{ name: "f" }],
    expectedTools: [{ name: "f" }],
  });
  const suite = () =>
    SuiteSchema.parse({
      id: "reasoning-split",
      version: "v1",
      categories: [ARITHMETIC, TOOL_CALLING],
      cases: [
        exactCase("separate-channel"),
        exactCase("inline-think"),
        exactCase("provider-reported"),
        toolLoopCase("tool-loop"),
        toolLoopCase("tool-loop-inline-think"),
      ],
    });
  const completion = { promptTokens: 3, completionTokens: 10 };
  const half = { promptTokens: 3, completionTokens: 5 };

  it("splits completion tokens by reasoning vs answer characters unless the provider reports them", async () => {
    const client = new ScriptedClient([
      { text: "42", reasoningText: "abcdefgh", usage: completion },
      { text: "<think>abcdef</think>42", usage: completion },
      { text: "42", reasoningText: "abcdefgh", usage: { ...completion, reasoningTokens: 4 } },
      { text: "", reasoningText: "abcd", toolCalls: [{ id: "c1", name: "f", args: {} }], usage: half },
      { text: "done", reasoningText: "xy", usage: half },
      { text: "<think>abcdefgh</think>", toolCalls: [{ id: "c2", name: "f", args: {} }], usage: half },
      { text: "done", usage: half },
    ]);

    const body = await benchmark(suite(), client);

    expect(body.caseResults.map((result) => [result.caseId, result.metrics.tokens.reasoning])).toEqual([
      ["separate-channel", 8],
      ["inline-think", 3],
      ["provider-reported", 4],
      ["tool-loop", 5],
      ["tool-loop-inline-think", 3],
    ]);
  });
});

describe("BenchmarkRunner — case timing", () => {
  const arithmetic = () =>
    oneCaseSuite(ARITHMETIC, { graderKind: "exact", prompt: { user: "17*23?" }, expected: "391" });

  it("times tok/s from each turn's first output, reasoning and tool-call fragments included, leaving out its wait", async () => {
    const TOOL_TURN = { waitMs: 1000, streamMs: 9000, completionTokens: 100 };
    const ANSWER_TURN = { waitMs: 2000, streamMs: 1000, completionTokens: 10 };
    let now = 0;
    const client: CompletionClient = {
      async stream(request, handlers) {
        const callsTool = !request.messages.some((message) => message.role === "tool");
        const turn = callsTool ? TOOL_TURN : ANSWER_TURN;
        now += turn.waitMs;
        if (callsTool) handlers?.onToolCallDelta?.();
        else handlers?.onReasoningDelta?.("thinking");
        now += turn.streamMs;
        return {
          text: callsTool ? "" : "done",
          toolCalls: callsTool ? [{ id: "c1", name: "f", args: {} }] : undefined,
          usage: { promptTokens: 10, completionTokens: turn.completionTokens },
          aborted: false,
        };
      },
    };
    const suite = oneCaseSuite(TOOL_CALLING, {
      graderKind: "tooltrace",
      prompt: { user: "call f" },
      tools: [{ name: "f" }],
      expectedTools: [{ name: "f" }],
    });

    const body = await benchmark(suite, client, { clock: () => now });

    const [result] = body.caseResults;
    expect(result.metrics.latencyMs).toBe(13_000);
    expect(result.metrics.tokensPerSecond).toBe(11);
    expect(body.metrics.tokensPerSecond).toBe(11);
  });

  it("leaves a model call out of tok/s when its whole output arrived in one burst", async () => {
    const BURST_TOOL_TURN = { waitMs: 3000, completionTokens: 100 };
    const ANSWER_TURN = { waitMs: 2000, streamMs: 1000, completionTokens: 10 };
    let now = 0;
    const client: CompletionClient = {
      async stream(request, handlers) {
        const callsTool = !request.messages.some((message) => message.role === "tool");
        if (callsTool) {
          now += BURST_TOOL_TURN.waitMs;
          handlers?.onToolCallDelta?.();
          return {
            text: "",
            toolCalls: [{ id: "c1", name: "f", args: {} }],
            usage: { promptTokens: 10, completionTokens: BURST_TOOL_TURN.completionTokens },
            aborted: false,
          };
        }
        now += ANSWER_TURN.waitMs;
        handlers?.onDelta?.("done");
        now += ANSWER_TURN.streamMs;
        return {
          text: "done",
          usage: { promptTokens: 10, completionTokens: ANSWER_TURN.completionTokens },
          aborted: false,
        };
      },
    };
    const suite = oneCaseSuite(TOOL_CALLING, {
      graderKind: "tooltrace",
      prompt: { user: "call f" },
      tools: [{ name: "f" }],
      expectedTools: [{ name: "f" }],
    });

    const [result] = (await benchmark(suite, client, { clock: () => now })).caseResults;

    expect(result.metrics.tokensPerSecond).toBe(10);
  });

  it("times a case from the attempt that answered, leaving out rate-limit backoff", async () => {
    const RATE_LIMITED_MS = 20_000;
    const ANSWER_MS = 1000;
    let now = 0;
    let requests = 0;
    const fetchImpl = (async () => {
      requests++;
      if (requests === 1) {
        now += RATE_LIMITED_MS;
        return new Response("slow down", { status: 429 });
      }
      now += ANSWER_MS;
      return sseResponse([{ choices: [{ index: 0, delta: { content: "391" }, finish_reason: "stop" }] }]);
    }) as unknown as typeof fetch;
    const client = new OpenAICompletionClient({
      apiKey: "x",
      baseUrl: "http://h/v1",
      fetchImpl,
      retry: { retries: 1, minTimeoutMs: 0, maxTimeoutMs: 0, onRetry: () => {} },
    });

    const body = await benchmark(arithmetic(), client, { clock: () => now });

    expect(requests).toBe(2);
    expect(body.caseResults[0].metrics.latencyMs).toBe(ANSWER_MS);
  });
});

describe("BenchmarkRunner — local run", () => {
  const MS_PER_HOUR = 3_600_000;
  const GPU_HOURLY_USD = 0.5;
  const MODEL_HASH = "a".repeat(64);
  const HARDWARE: Hardware = {
    platform: "linux",
    arch: "x64",
    osVersion: "Linux 6.8.0",
    cpuModel: "AMD Ryzen 9 7950X",
    cpuCores: 32,
    totalRamMb: 65536,
    accelerators: [{ kind: "cuda", name: "NVIDIA GeForce RTX 4090", memoryMb: 24564 }],
    memoryModel: "discrete-vram",
  };
  const MEMORY_USAGE: MemoryUsage = {
    kind: "vram",
    peakMb: 14680,
    avgMb: 14200.5,
    samples: 7,
    source: "nvidia-smi (process)",
  };
  const measuredMemory: MemoryMonitor = {
    start: () => {},
    stop: async () => MEMORY_USAGE,
    probe: async () => ({ mb: MEMORY_USAGE.peakMb, kind: MEMORY_USAGE.kind }),
    usage: () => MEMORY_USAGE,
  };
  const suite = oneCaseSuite(ARITHMETIC, { graderKind: "exact", prompt: { user: "17*23?" }, expected: "391" });

  it("records the memory read so far on every checkpoint, so a stopped run keeps it", async () => {
    const checkpoints: Artifact[] = [];
    await benchmark(suite, new ScriptedClient(["391"]), {
      memoryMonitor: measuredMemory,
      onCheckpoint: (artifact) => {
        checkpoints.push(artifact);
      },
    });

    expect(checkpoints[0].metrics.memory).toEqual(MEMORY_USAGE);
  });

  it("bills GPU time as an estimate and records memory, hardware, the model hash and the model that answered", async () => {
    let now = 0;

    const body = await benchmark(suite, new ScriptedClient([{ text: "391", model: "qwen2.5-7b-instruct-q4_k_m" }]), {
      identity: identity(suite, { hardware: HARDWARE, modelHash: MODEL_HASH }),
      cost: { gpuHourlyUsd: GPU_HOURLY_USD },
      memoryMonitor: measuredMemory,
      clock: () => (now += MS_PER_HOUR),
    });

    expect(body.cost).toEqual({ amountUsd: GPU_HOURLY_USD, currency: "USD", estimated: true });
    expect(body.metrics.memory).toEqual(MEMORY_USAGE);
    expect(body.metrics.vramMb).toBe(MEMORY_USAGE.peakMb);
    expect(body.run.hardware).toEqual(HARDWARE);
    expect(body.reproduce.modelHash).toBe(MODEL_HASH);
    expect(body.model.metadata?.resolvedModelIds).toEqual(["qwen2.5-7b-instruct-q4_k_m"]);
  });
});
