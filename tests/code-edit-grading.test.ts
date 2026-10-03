import { describe, expect, it } from "vitest";
import { grade } from "dabench/engine/grader";
import { TestCaseSchema, type TestCase } from "dabench/engine/suite";

const FILE = [
  "function total(items) {",
  "  let sum = 0;",
  "  for (const item of items) sum += item.price;",
  "  return sum;",
  "}",
  "",
  "function label(item) {",
  "  return item.name;",
  "}",
  "",
].join("\n");

const editCase: TestCase = TestCaseSchema.parse({
  id: "edit1",
  category: "coding",
  tier: 2,
  graderKind: "unit-test",
  prompt: { user: "total() must multiply each price by its quantity." },
  unitTests: {
    entry: "total",
    editFile: FILE,
    cases: [
      {
        name: "quantities",
        args: [
          [
            { price: 2, qty: 3 },
            { price: 1, qty: 1 },
          ],
        ],
        expected: 7,
      },
      { name: "empty", args: [[]], expected: 0 },
    ],
  },
});

const block = (search: string, replace: string) => `<<<<<<< SEARCH\n${search}=======\n${replace}>>>>>>> REPLACE`;

describe("Grader — code edits as SEARCH/REPLACE blocks", () => {
  it("passes prototype-named keys to candidate code as own JSON data", async () => {
    const value = JSON.parse('{"__proto__":{"x":1},"constructor":7}');
    const task = TestCaseSchema.parse({
      id: "json-own-keys",
      category: "coding",
      tier: 2,
      graderKind: "unit-test",
      prompt: { user: "Return the input unchanged." },
      unitTests: { entry: "solve", cases: [{ name: "own-key", args: [value], expected: value }] },
    });
    expect((await grade(task, { text: "function solve(value) { return value; }" })).score).toBe(100);
    expect((await grade(task, { text: "function solve(value) { delete value.__proto__; return value; }" })).score).toBe(
      0,
    );
  });

  it("applies the blocks in order, then runs the hidden tests on the edited file", async () => {
    const answer = [
      "Here's the fix:",
      "```",
      block(
        "  for (const item of items) sum += item.price;\n",
        "  for (const item of items) sum += item.price * item.qty;\n",
      ),
      "```",
    ].join("\n");
    const r = await grade(editCase, { text: answer });
    expect(r).toMatchObject({ score: 100, correctness: 1 });
    expect(r.assertions[0]).toEqual({ name: "edits-apply", passed: true });
  });

  it.each([
    [
      "a block's SEARCH text isn't in the file",
      block("  for (const x of items) sum += x.price;\n", "  return 7;\n"),
      "block 1: the SEARCH text is not in the file",
    ],
    [
      "a block's SEARCH text matches more than one place",
      block("}\n", "};\n"),
      "block 1: the SEARCH text matches 2 places",
    ],
    [
      "the answer sends the whole file instead of blocks",
      "```js\n" + FILE.replace("item.price", "item.price * item.qty") + "```",
      "no SEARCH/REPLACE blocks in the answer",
    ],
  ])("fails every test when %s", async (_, answer, detail) => {
    const r = await grade(editCase, { text: answer });
    expect(r.correctness).toBe(0);
    expect(r.assertions).toEqual([
      { name: "edits-apply", passed: false, detail },
      { name: "test:quantities", passed: false, detail: "the edits did not apply" },
      { name: "test:empty", passed: false, detail: "the edits did not apply" },
    ]);
  });
});
