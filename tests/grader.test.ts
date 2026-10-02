import { describe, expect, it, vi } from "vitest";
import { grade, type GradeResult } from "dabench/engine/grader";
import { stripReasoning } from "dabench/engine/inline-reasoning";
import type { JsonSchemaSpec } from "dabench/engine/json-schema";
import { TestCaseSchema, type TestCase } from "dabench/engine/suite";

type CaseOf<K extends TestCase["graderKind"]> = Extract<TestCase, { graderKind: K }>;

const base = { id: "c1", category: "cat", tier: 2 as const, prompt: { user: "do the task" } };

function gradeText(testCase: TestCase, text: string): Promise<GradeResult> {
  return grade(testCase, { text });
}

const PAST_SANDBOX_START_TIMEOUT_MS = 60_000;

describe("stripReasoning — inline chain-of-thought never reaches a grader", () => {
  it.each([
    ["<THINK>a</THINK>x<think>b</think>y", "xy"],
    ["<thinking>hmm</thinking>4", "4"],
    ["4\n<think>wait, actually", "4"],
    ["<think>never closes", ""],
  ])("reduces %j to the answer %j (closed, tag-variant, and truncated blocks)", (raw, answer) => {
    expect(stripReasoning(raw)).toBe(answer);
  });

  it("applies before exact grading via await grade()", async () => {
    const c: TestCase = { ...base, graderKind: "exact", expected: "4" };
    const r = await gradeText(c, "<think>2 and 2 makes 4</think>4");
    expect(r.score).toBe(100);
  });
});

describe("Grader — exact", () => {
  it.each([
    ["391", "391", 100],
    ["  391\n", "391", 100],
    ["paris", "Paris", 0],
  ])("scores %j against %j as %i", async (answer, expected, score) => {
    const r = await gradeText({ ...base, graderKind: "exact", expected }, answer);
    expect(r).toMatchObject({ score, correctness: score / 100, quality: 100 });
    expect(r.assertions[0]).toMatchObject({ name: "exact-match", passed: score === 100 });
  });
});

describe("Grader — schema", () => {
  const c: CaseOf<"schema"> = {
    ...base,
    graderKind: "schema",
    schema: {
      type: "object",
      required: ["name", "age"],
      properties: { name: { type: "string" }, age: { type: "integer" } },
    },
  };

  it("scores a bare conforming JSON value 100 with a passing format assertion", async () => {
    const r = await gradeText(c, '{"name":"Ada","age":36}');
    expect(r).toMatchObject({ score: 100, correctness: 1, quality: 100 });
    expect(r.assertions.find((a) => a.name === "response-format")?.passed).toBe(true);
  });

  it.each<[string, JsonSchemaSpec, string, string]>([
    ["a missing required field", c.schema, '{"name":"Ada"}', "$.age: required"],
    ["a wrong field type", c.schema, '{"name":"Ada","age":"old"}', "$.age: integer"],
    ["a value outside the enum", { type: "string", enum: ["red", "green", "blue"] }, '"purple"', "$: enum"],
  ])("fails the contract on %s", async (_, schema, answer, failing) => {
    const r = await gradeText({ ...base, graderKind: "schema", schema }, answer);
    expect(r).toMatchObject({ score: 0, correctness: 0 });
    expect(r.assertions.find((a) => a.name === failing)?.passed).toBe(false);
  });

  it("scores unparseable output 0 with a failed parse gate", async () => {
    const r = await gradeText(c, "I cannot help with that.");
    expect(r).toMatchObject({ score: 0, correctness: 0 });
    expect(r.assertions[0]).toMatchObject({ name: "json-parses", passed: false });
  });

  it("enforces strict objects, bounds, patterns, formats, and unique arrays", async () => {
    const strict: TestCase = {
      ...base,
      graderKind: "schema",
      schema: {
        type: "object",
        required: ["email", "score", "tags"],
        additionalProperties: false,
        properties: {
          email: { type: "string", format: "email", pattern: "@example\\.com$" },
          score: { type: "number", minimum: 0, maximum: 1 },
          tags: { type: "array", minItems: 2, maxItems: 2, uniqueItems: true, items: { type: "string" } },
        },
      },
    };
    expect((await gradeText(strict, '{"email":"a@example.com","score":0.8,"tags":["a","b"]}')).score).toBe(100);
    const bad = await gradeText(strict, '{"email":"nope","score":2,"tags":["a","a"],"extra":true}');
    expect(bad.score).toBe(0);
    expect(bad.assertions.filter((a) => !a.passed).map((a) => a.name)).toEqual(
      expect.arrayContaining([
        "$: additionalProperties",
        "$.email: format:email",
        "$.score: maximum",
        "$.tags: uniqueItems",
      ]),
    );
  });

  it("counts keys named like Object.prototype members as additional properties", async () => {
    const strict: TestCase = {
      ...base,
      graderKind: "schema",
      schema: {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: { name: { type: "string" } },
      },
    };
    const r = await gradeText(strict, '{"name":"x","constructor":1,"__proto__":2}');
    expect(r.score).toBe(0);
    expect(r.assertions).toContainEqual({
      name: "$: additionalProperties",
      passed: false,
      detail: "unexpected key(s): constructor, __proto__",
    });
  });
});

describe("Grader — semantic JSON match", () => {
  it("ignores object-key order but rejects missing and extra keys, even one named __proto__", async () => {
    const c: TestCase = {
      ...base,
      graderKind: "json-match",
      jsonMatch: { expected: { a: 1, b: [2, 3] }, mode: "exact", arrayOrder: "ordered" },
    };
    expect((await gradeText(c, '{"b":[2,3],"a":1}')).score).toBe(100);
    expect((await gradeText(c, '{"a":1}')).score).toBe(0);
    expect((await gradeText(c, '{"a":1,"b":[2,3],"c":4}')).score).toBe(0);
    expect((await gradeText(c, '{"a":1,"b":[2,3],"__proto__":{"evil":true}}')).score).toBe(0);
  });

  it("compares every array as a multiset when array order is unordered", async () => {
    const c = TestCaseSchema.parse({
      ...base,
      graderKind: "json-match",
      jsonMatch: {
        expected: { labels: ["billing", "refund"], items: [{ sku: "a", tags: ["x", "y"] }, { sku: "b" }] },
        arrayOrder: "unordered",
      },
    });
    expect(
      (await gradeText(c, '{"items":[{"sku":"b"},{"tags":["y","x"],"sku":"a"}],"labels":["refund","billing"]}')).score,
    ).toBe(100);
    expect(
      (await gradeText(c, '{"items":[{"sku":"b"},{"sku":"a","tags":["x","y"]}],"labels":["refund","refund"]}')).score,
    ).toBe(0);
    expect((await gradeText(c, '{"items":[{"sku":"a","tags":["x","y"]}],"labels":["billing","refund"]}')).score).toBe(
      0,
    );
  });

  it("docks quality when the match is right but the strict format is broken", async () => {
    const c: TestCase = {
      ...base,
      graderKind: "json-match",
      jsonMatch: { expected: { a: 1 }, mode: "exact", arrayOrder: "ordered" },
    };
    const r = await gradeText(c, 'Result:\n```json\n{"a":1}\n```');
    expect(r).toMatchObject({ correctness: 1, quality: 70, score: 70 });
  });
});

describe("Grader — tooltrace (native tool traces only)", () => {
  const tools = [{ name: "search" }, { name: "fetch" }, { name: "log" }];
  const c: TestCase = {
    ...base,
    graderKind: "tooltrace",
    tools,
    expectedTools: [{ name: "search", args: { query: "x" } }, { name: "fetch" }],
  };
  const out = (calls: Array<{ name: string; args?: Record<string, unknown> }>) => ({ text: "", toolCalls: calls });

  const search = { name: "search", args: { query: "x" } };
  it.each([
    ["the expected ordered trace", [search, { name: "fetch" }], 100],
    ["a wrong argument on one call", [{ name: "search", args: { query: "WRONG" } }, { name: "fetch" }], 50],
    ["a missing call", [search], 50],
    ["an extra trailing call, over the longer trace", [search, { name: "fetch" }, { name: "log" }], 67],
    ["one inserted call, costing that call and not the whole tail", [{ name: "log" }, search, { name: "fetch" }], 67],
  ])("scores %s at %i", async (_, calls, score) => {
    expect((await grade(c, out(calls))).score).toBe(score);
  });

  it("fails outright when the model never engaged the tools API", async () => {
    const asText = await gradeText(c, '[{"name":"search","arguments":{"query":"x"}}]');
    expect(asText).toMatchObject({ score: 0, correctness: 0 });
    expect(asText.assertions[0]).toMatchObject({ name: "tool-calls-made", passed: false });

    const prose = await grade(c, { text: "I would call search then fetch." });
    expect(prose.score).toBe(0);
  });

  it("supports recursive subset args and exact args", async () => {
    const subsetArgs: CaseOf<"tooltrace"> = {
      ...base,
      graderKind: "tooltrace",
      tools: [{ name: "a" }, { name: "b" }],
      expectedTools: [{ name: "a", args: { filter: { status: "open" } } }, { name: "b" }],
    };
    expect(
      (await grade(subsetArgs, out([{ name: "a", args: { filter: { status: "open", team: "x" } } }, { name: "b" }])))
        .score,
    ).toBe(100);

    const exactArgs: TestCase = {
      ...subsetArgs,
      expectedTools: [{ name: "a", args: { x: 1 } }],
      toolOptions: { order: "strict", allowExtraCalls: false, argumentMatch: "exact" },
    };
    const r = await grade(exactArgs, out([{ name: "a", args: { x: 1, y: 2 } }]));
    expect(r.score).toBe(0);
    expect(r.assertions.find((a) => a.name === "call[0] a")?.detail).toContain("y: unexpected");
  });

  it("passes a no-call case only when the model makes no call", async () => {
    const restraint = TestCaseSchema.parse({ ...base, graderKind: "tooltrace", tools, expectedTools: [] });
    expect(await grade(restraint, { text: "Nothing to do here.", toolCalls: [] })).toMatchObject({
      score: 100,
      correctness: 1,
    });

    const called = await grade(restraint, out([{ name: "search", args: { query: "x" } }]));
    expect(called).toMatchObject({ score: 0, correctness: 0 });
    expect(called.assertions.find((a) => a.name === "call-count")).toMatchObject({
      passed: false,
      detail: "1 unexpected extra call(s)",
    });
  });

  it("checks the final reply with rubric rules, and a failed required rule fails the case", async () => {
    const asksForId = TestCaseSchema.parse({
      ...base,
      graderKind: "tooltrace",
      tools,
      expectedTools: [],
      reply: [
        { id: "asks-order-number", required: true, check: { regex: "order (number|id)", flags: "i" } },
        { id: "polite", weight: 1, check: { contains: "please" } },
      ],
    });

    expect(await grade(asksForId, { text: "Which order number is this about, please?", toolCalls: [] })).toMatchObject({
      score: 100,
      correctness: 1,
      quality: 100,
    });

    const invented = await grade(asksForId, { text: "Refund issued for order 1001.", toolCalls: [] });
    expect(invented).toMatchObject({ score: 0, correctness: 0 });
    expect(invented.assertions.find((a) => a.name === "reply:asks-order-number")?.passed).toBe(false);

    const curt = await grade(asksForId, { text: "Order number?", toolCalls: [] });
    expect(curt).toMatchObject({ correctness: 1, quality: 0, score: 0 });

    const withCalls = TestCaseSchema.parse({
      ...c,
      reply: [{ id: "confirms", required: true, check: { contains: "fetched" } }],
    });
    const traced = [{ name: "search", args: { query: "x" } }, { name: "fetch" }];
    expect((await grade(withCalls, { text: "I fetched it.", toolCalls: traced })).score).toBe(100);
    expect((await grade(withCalls, { text: "Done.", toolCalls: traced })).score).toBe(0);
  });

  it("treats string-typed numbers as a real argument mismatch under exact match", async () => {
    const typed: TestCase = {
      ...base,
      graderKind: "tooltrace",
      tools: [{ name: "seal" }],
      expectedTools: [{ name: "seal", args: { digest: 8740 } }],
      toolOptions: { order: "strict", allowExtraCalls: false, argumentMatch: "exact" },
    };
    const r = await grade(typed, out([{ name: "seal", args: { digest: "8740" } }]));
    expect(r.score).toBe(0);
    expect(r.assertions.find((a) => a.name === "call[0] seal")?.detail).toContain('digest: got "8740", want 8740');
  });
});

describe("Grader — unit-test", () => {
  const c: TestCase = {
    ...base,
    graderKind: "unit-test",
    unitTests: {
      entry: "add",
      cases: [
        { name: "positives", args: [2, 3], expected: 5 },
        { name: "mixed", args: [10, -4], expected: 6 },
      ],
    },
  };

  it("runs the model's code from a tagged fence and scores all-passing 100", async () => {
    const r = await gradeText(c, "```js\nfunction add(a, b) { return a + b; }\n```");
    expect(r.score).toBe(100);
    expect(r.assertions.find((a) => a.name === "code-compiles")?.passed).toBe(true);
  });

  it("gives partial credit when some cases fail", async () => {
    const r = await gradeText(c, "function add(a, b) { return a + Math.abs(b); }");
    expect(r.score).toBe(50);
    expect(r.assertions.find((a) => a.name === "test:mixed")?.passed).toBe(false);
  });

  it("runs setup code before the answer, so the answer can build on an existing module", async () => {
    const onModule = TestCaseSchema.parse({
      ...base,
      graderKind: "unit-test",
      unitTests: {
        setup: "const inventory = { stock: { a: 3, b: 0 }, available(sku) { return this.stock[sku] ?? 0; } };",
        entry: "canShip",
        cases: [
          { name: "in stock", args: ["a", 2], expected: true },
          { name: "sold out", args: ["b", 1], expected: false },
        ],
      },
    });
    expect(
      (await gradeText(onModule, "function canShip(sku, qty) { return inventory.available(sku) >= qty; }")).score,
    ).toBe(100);
    expect((await gradeText(onModule, "function canShip(sku, qty) { return stock[sku] >= qty; }")).score).toBe(0);
  });

  it("fails the case, not the run, when the sandbox doesn't start in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const graded = gradeText(c, "function add(a, b) { return a + b; }");
      vi.advanceTimersByTime(PAST_SANDBOX_START_TIMEOUT_MS);
      const r = await graded;
      expect(r.score).toBe(0);
      expect(r.assertions[0]).toEqual({
        name: "code-compiles",
        passed: false,
        detail: "the JavaScript sandbox did not start",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("scores non-compiling code 0 with a failed compile gate", async () => {
    const r = await gradeText(c, "function add(a, b) { return a + }");
    expect(r).toMatchObject({ score: 0, correctness: 0 });
    expect(r.assertions[0]).toMatchObject({ name: "code-compiles", passed: false });
  });

  it("fails cleanly when the entry point is not defined", async () => {
    const r = await gradeText(c, "function sum(a, b) { return a + b; }");
    expect(r.score).toBe(0);
    expect(r.assertions.find((a) => a.name === "code-compiles")?.passed).toBe(true);
    expect(r.assertions.filter((a) => a.name.startsWith("test:")).every((a) => !a.passed)).toBe(true);
  });

  it("does not expose host constructors through arguments or the VM global", async () => {
    const throughArg = await gradeText(
      c,
      'function add(a) { return a.constructor.constructor("return process")().version; }',
    );
    expect(throughArg.score).toBe(0);
    expect(throughArg.assertions.some((a) => a.detail?.match(/code generation|process|threw/i))).toBe(true);

    const throughGlobal = await gradeText(
      c,
      'function add() { return this.constructor.constructor("return process")().version; }',
    );
    expect(throughGlobal.score).toBe(0);
    expect(throughGlobal.assertions.some((a) => a.detail?.match(/threw|code generation/i))).toBe(true);
  });

  const oneCase: TestCase = {
    ...base,
    graderKind: "unit-test",
    unitTests: { entry: "add", cases: [{ name: "positives", args: [2, 3], expected: 5 }] },
  };

  it.each([
    ["exhausts memory", "function add() { const hoard = []; for (;;) hoard.push(new Array(1e6).fill(0)); }"],
    [
      "floods the microtask queue",
      "function add(a, b) { const spin = () => Promise.resolve().then(spin); spin(); return a + b; }",
    ],
  ])("fails answer code that %s instead of crashing or hanging the benchmark", async (_, answer) => {
    expect((await gradeText(oneCase, answer)).score).toBe(0);
  });
});

describe("Grader — rubric (deterministic correctness × quality)", () => {
  const c: TestCase = {
    ...base,
    graderKind: "rubric",
    rubric: [
      { id: "gate", description: "must say MUST", required: true, weight: 1, check: { contains: "MUST" } },
      { id: "good", weight: 1, required: false, check: { contains: "good" } },
      { id: "fast", weight: 3, required: false, check: { regex: "\\bfast\\b" } },
    ],
  };

  it("zeroes the score when a required criterion fails, regardless of quality", async () => {
    const r = await gradeText(c, "This is good and fast.");
    expect(r.correctness).toBe(0);
    expect(r.quality).toBe(100);
    expect(r.score).toBe(0);
  });

  it("weights quality criteria (weight 3 vs 1)", async () => {
    const onlyFast = await gradeText(c, "This MUST be fast.");
    expect(onlyFast).toMatchObject({ correctness: 1, quality: 75, score: 75 });

    const onlyGood = await gradeText(c, "This MUST be good.");
    expect(onlyGood).toMatchObject({ correctness: 1, quality: 25, score: 25 });
  });

  it("fails an answer with a number outside the allowed list (1,200 reads as 1200, 09 as 9, p95 is a name)", async () => {
    const summary = TestCaseSchema.parse({
      ...base,
      graderKind: "rubric",
      rubric: [{ id: "no-invented-numbers", required: true, check: { numbersWithin: [1200, 4.5, 2026, 9, 25, 3] } }],
    });
    expect(
      (await gradeText(summary, "On 2026-09-25 we moved 1,200 users; p95 fell to 4.5s across 3 regions.")).score,
    ).toBe(100);
    expect((await gradeText(summary, "No numbers at all.")).score).toBe(100);

    const invented = await gradeText(summary, "We moved 1,200 users, about 40% of the base.");
    expect(invented).toMatchObject({ score: 0, correctness: 0 });
    expect(invented.assertions[0]).toMatchObject({ name: "no-invented-numbers", passed: false });
    expect((await gradeText(summary, "p95 fell to 4.50s.")).score).toBe(100);
    expect((await gradeText(summary, "p95 fell to 4.6s.")).score).toBe(0);
  });

  it("supports normalized equality, case-insensitive sets, negative regex, and word/line counts", async () => {
    const checks: TestCase = {
      ...base,
      graderKind: "rubric",
      rubric: [
        { id: "facts", required: true, weight: 1, check: { containsAll: ["alpha", "BETA"], caseSensitive: false } },
        { id: "no-secret", required: true, weight: 1, check: { notRegex: "sk-[a-z0-9]+", flags: "i" } },
        { id: "words", required: false, weight: 1, check: { wordCount: { min: 2, max: 4 } } },
        { id: "lines", required: false, weight: 1, check: { lineCount: { min: 2, max: 2 } } },
      ],
    };
    expect((await gradeText(checks, "Alpha\nbeta")).score).toBe(100);
    expect((await gradeText(checks, "Alpha beta sk-leak")).score).toBe(0);

    const equals: TestCase = {
      ...base,
      graderKind: "rubric",
      rubric: [
        {
          id: "e",
          required: true,
          weight: 1,
          check: { equals: "READY TO SHIP", caseSensitive: false, normalizeWhitespace: true },
        },
      ],
    };
    expect((await gradeText(equals, " ready   to ship ")).score).toBe(100);
  });
});
