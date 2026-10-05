import { describe, expect, it } from "vitest";
import { JsonSchemaSpecSchema } from "../src/engine/json-schema";
import { CategoryDescriptorSchema, GENERATION_PROFILES } from "../src/engine/schema";
import { SuiteSchema, TestCaseSchema } from "../src/engine/suite";

const base = { id: "c", category: "test", tier: 2 as const, prompt: { user: "do a substantive test task" } };

describe("suite authoring validation", () => {
  it("requires a coherent per-category generation policy", () => {
    expect(
      CategoryDescriptorSchema.safeParse({
        slug: "reasoning",
        label: "Reasoning",
        short: "REASON",
      }).success,
    ).toBe(false);
    expect(
      CategoryDescriptorSchema.safeParse({
        slug: "reasoning",
        label: "Reasoning",
        short: "REASON",
        generation: {
          reasoningTokens: 4096,
          reasoningEffort: "medium",
          maxOutputTokens: 8192,
        },
      }).success,
    ).toBe(false);
    expect(
      CategoryDescriptorSchema.safeParse({
        slug: "reasoning",
        label: "Reasoning",
        short: "REASON",
        generation: {
          reasoningTokens: 4096,
          reasoningEffort: "high",
          maxOutputTokens: 4096,
        },
      }).success,
    ).toBe(false);
  });

  it("rejects type-inappropriate and contradictory JSON-schema keywords", () => {
    expect(JsonSchemaSpecSchema.safeParse({ type: "string", minItems: 2 }).success).toBe(false);
    expect(JsonSchemaSpecSchema.safeParse({ type: "number", minimum: 10, maximum: 2 }).success).toBe(false);
    expect(JsonSchemaSpecSchema.safeParse({ type: "object", required: ["id"], properties: {} }).success).toBe(false);
    expect(JsonSchemaSpecSchema.safeParse({ type: "array", minItems: 3, maxItems: 2 }).success).toBe(false);
    expect(JsonSchemaSpecSchema.safeParse({ type: "object", required: ["constructor"], properties: {} }).success).toBe(
      false,
    );
  });

  it("rejects malformed regex checks and duplicate rubric IDs", () => {
    expect(
      TestCaseSchema.safeParse({
        ...base,
        graderKind: "rubric",
        rubric: [{ id: "bad", required: true, check: { regex: "[" } }],
      }).success,
    ).toBe(false);
    expect(
      TestCaseSchema.safeParse({
        ...base,
        graderKind: "rubric",
        rubric: [
          { id: "same", required: true, check: { contains: "a" } },
          { id: "same", check: { contains: "b" } },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects ignored grader payloads instead of silently hashing dead config", () => {
    expect(
      TestCaseSchema.safeParse({
        ...base,
        graderKind: "exact",
        expected: "yes",
        schema: { type: "string" },
      }).success,
    ).toBe(false);
  });

  it("rejects tool traces that reference undeclared tools", () => {
    expect(
      TestCaseSchema.safeParse({
        ...base,
        graderKind: "tooltrace",
        tools: [{ name: "search" }],
        expectedTools: [{ name: "fetch" }],
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      "an entry point that isn't a plain identifier path",
      { entry: "globalThis.constructor('return process')()", cases: [{ name: "x", args: [], expected: 1 }] },
    ],
    [
      "duplicate hidden-case names",
      {
        entry: "solve",
        cases: [
          { name: "same", args: [], expected: 1 },
          { name: "same", args: [], expected: 2 },
        ],
      },
    ],
    [
      "an edit file whose last line has no newline, unlike the prompt that shows it",
      { entry: "solve", editFile: "function solve() {}", cases: [{ name: "x", args: [], expected: 1 }] },
    ],
  ])("rejects unit tests with %s", (_, unitTests) => {
    expect(TestCaseSchema.safeParse({ ...base, graderKind: "unit-test", unitTests }).success).toBe(false);
  });
});

const [GENERATION] = GENERATION_PROFILES;
const CLASS = [{ slug: "classification", label: "Classification", short: "CLASS", generation: GENERATION }];

describe("suite schema", () => {
  const exact = (id: string, inCategory = "classification") => ({
    id,
    category: inCategory,
    tier: 2,
    graderKind: "exact",
    prompt: { user: "q" },
    expected: "1",
  });
  const EMPTY = { slug: "empty", label: "Empty", short: "EMPTY", generation: GENERATION };

  it.each([
    ["a case in a category the suite doesn't declare", CLASS, [exact("a", "reasoning")], /does not declare/],
    ["duplicate case IDs", CLASS, [exact("same"), exact("same")], /duplicate case id/],
    ["a declared category with no cases", [...CLASS, EMPTY], [exact("a")], /has no cases/],
  ])("rejects %s", (_, categories, cases, message) => {
    expect(() => SuiteSchema.parse({ id: "s", version: "v1", categories, cases })).toThrow(message);
  });
});

describe("scripted turns", () => {
  it("allows scripted turns only on cases without tools", () => {
    const withTools = {
      id: "t",
      category: "writing",
      tier: 1,
      graderKind: "tooltrace",
      prompt: { user: "go", turns: ["again"] },
      tools: [{ name: "a" }],
      expectedTools: [],
    };
    expect(TestCaseSchema.safeParse(withTools).success).toBe(false);
  });
});
