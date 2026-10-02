import { canonicalize } from "../canonical";
import { fencedBlocks } from "../extract";
import { runSqlQuery } from "../sql-query";
import { RowOrder, type SqlSpec } from "../suite";
import { assertion, failedGate, FULL_QUALITY, previewJson, WIDE_PREVIEW_CHARS, type Grading } from "./verdict";

const QUERY_RUNS = "query-runs";
const RESULT_SET = "result-set";
const SQL_NUMBER_SCALE = 1e6;

export async function gradeSql(spec: SqlSpec, answer: string): Promise<Grading> {
  const run = await runSqlQuery(spec, extractSql(answer));
  if (!run.ok) return failedGate(QUERY_RUNS, run.error);
  const difference = rowsDifference(spec.expected.map(roundedRow), run.rows.map(roundedRow), spec.order);
  return {
    correctness: difference === null ? 1 : 0,
    quality: FULL_QUALITY,
    assertions: [assertion(QUERY_RUNS, true), assertion(RESULT_SET, difference === null, difference ?? undefined)],
  };
}

/** The query in the last fenced block, or the whole answer, without a trailing semicolon. */
function extractSql(answer: string): string {
  return (fencedBlocks(answer).at(-1) ?? answer).trim().replace(/;\s*$/u, "");
}

function roundedRow(row: unknown[]): unknown[] {
  return row.map((value) =>
    typeof value === "number" ? Math.round(value * SQL_NUMBER_SCALE) / SQL_NUMBER_SCALE : value,
  );
}

function rowsDifference(want: unknown[][], got: unknown[][], order: RowOrder): string | null {
  if (want.length !== got.length) return `got ${got.length} rows, want ${want.length}`;
  const shown = (row: unknown[]) => previewJson(row, WIDE_PREVIEW_CHARS);
  if (order === RowOrder.Ordered) {
    const index = want.findIndex((row, i) => canonicalize(row) !== canonicalize(got[i]));
    return index === -1 ? null : `row ${index + 1}: got ${shown(got[index])}, want ${shown(want[index])}`;
  }
  const unmatched = got.map(canonicalize);
  for (const row of want) {
    const at = unmatched.indexOf(canonicalize(row));
    if (at === -1) return `missing row ${shown(row)}`;
    unmatched.splice(at, 1);
  }
  return null;
}
