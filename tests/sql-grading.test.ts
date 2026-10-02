import { describe, expect, it } from "vitest";
import { grade } from "dabench/engine/grader";
import { TestCaseSchema, type TestCase } from "dabench/engine/suite";

const SCHEMA = "CREATE TABLE orders (id INTEGER PRIMARY KEY, customer TEXT NOT NULL, total_cents INTEGER NOT NULL);";
const SEED = "INSERT INTO orders VALUES (1, 'ana', 1200), (2, 'ben', 800), (3, 'ana', 500);";
const SQL_TEST_TIMEOUT_MS = 20_000;

function sqlCase(expected: unknown[][], order: "ordered" | "unordered" = "unordered"): TestCase {
  return TestCaseSchema.parse({
    id: "sql1",
    category: "sql",
    tier: 1,
    graderKind: "sql",
    prompt: { user: "Total spend per customer, biggest first." },
    sql: { schema: SCHEMA, seed: SEED, expected, order },
  });
}

describe("Grader — SQL run against seeded data", { timeout: SQL_TEST_TIMEOUT_MS }, () => {
  it("passes a query whose rows match, ignoring column names and row order", async () => {
    const answer = "```sql\nSELECT customer AS who, SUM(total_cents) FROM orders GROUP BY customer;\n```";
    const r = await grade(
      sqlCase([
        ["ben", 800],
        ["ana", 1700],
      ]),
      { text: answer },
    );
    expect(r).toMatchObject({ score: 100, correctness: 1 });
    expect(r.assertions).toEqual([
      { name: "query-runs", passed: true },
      { name: "result-set", passed: true },
    ]);
  });

  it("checks row order when the case asks for it", async () => {
    const unsorted = "SELECT customer, SUM(total_cents) FROM orders GROUP BY customer ORDER BY customer DESC";
    const r = await grade(
      sqlCase(
        [
          ["ana", 1700],
          ["ben", 800],
        ],
        "ordered",
      ),
      { text: unsorted },
    );
    expect(r.correctness).toBe(0);
    expect(r.assertions[1]).toEqual({
      name: "result-set",
      passed: false,
      detail: 'row 1: got ["ben",800], want ["ana",1700]',
    });
  });

  it("compares numbers to 6 decimal places and reports a wrong row count", async () => {
    const third = await grade(sqlCase([[0.333333]]), { text: "SELECT 1.0 / 3" });
    expect(third.score).toBe(100);
    const tooMany = await grade(sqlCase([["ana"]]), { text: "SELECT customer FROM orders" });
    expect(tooMany.assertions[1]).toMatchObject({ passed: false, detail: "got 3 rows, want 1" });
  });

  it("refuses writes, attached files and pragmas", async () => {
    for (const query of ["DELETE FROM orders", "ATTACH DATABASE '/tmp/x.db' AS x", "PRAGMA table_info(orders)"]) {
      const r = await grade(sqlCase([]), { text: query });
      expect(r.assertions[0]).toEqual({ name: "query-runs", passed: false, detail: "not authorized" });
    }
  });

  it("stops a query that runs too long", async () => {
    const forever = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT COUNT(*) FROM n";
    const r = await grade(sqlCase([[1]]), { text: forever });
    expect(r.assertions[0]).toMatchObject({
      name: "query-runs",
      passed: false,
      detail: expect.stringContaining("longer"),
    });
  });
});
