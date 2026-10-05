import { isPassed } from "../engine/aggregator";
import { ArtifactSchema, type Artifact, type CaseResult } from "../engine/schema";
import { enumFlag, fail, readJsonFile, requireFlag, type Flags } from "./args";

export enum ExportFlag {
  Artifact = "artifact",
  Format = "format",
}

export enum ExportFormat {
  Csv = "csv",
  Jsonl = "jsonl",
}

type ExportedRun = Pick<Artifact, "runId" | "model" | "caseResults">;
type CaseRow = ReturnType<typeof caseRow>;

const CSV_NEEDS_QUOTES = /[",\n\r]/;
const CSV_QUOTE = '"';
const LINE_END = "\n";

export function cmdExport(flags: Flags): void {
  const path = requireFlag(flags, ExportFlag.Artifact);
  const format = enumFlag(flags, ExportFlag.Format, ExportFormat) ?? ExportFormat.Csv;
  process.stdout.write(exportCases(readArtifact(path), format));
}

export function exportCases(run: ExportedRun, format: ExportFormat): string {
  const rows = run.caseResults.map((result) => caseRow(run, result));
  return format === ExportFormat.Csv ? toCsv(rows) : toJsonLines(rows);
}

function readArtifact(path: string): Artifact {
  const parsed = ArtifactSchema.safeParse(readJsonFile(path));
  if (!parsed.success) fail(`${path} is not a run artifact (the JSON file a run writes)`);
  return parsed.data;
}

function caseRow(run: ExportedRun, result: CaseResult) {
  const { tokens, tokensPerSecond, latencyMs, vramMb } = result.metrics;
  return {
    run_id: run.runId,
    model: run.model.id,
    case_id: result.caseId,
    category: result.category,
    grader: result.graderKind,
    passed: isPassed(result),
    score: result.score,
    correctness: result.correctness,
    quality: result.quality,
    failed_assertions: result.assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.name),
    finish_reason: result.finishReason,
    prompt_tokens: tokens.prompt,
    completion_tokens: tokens.completion,
    reasoning_tokens: tokens.reasoning,
    total_tokens: tokens.total,
    tokens_per_second: tokensPerSecond,
    latency_ms: latencyMs,
    vram_mb: vramMb,
    tool_calls: result.toolCalls ?? null,
    response: result.response,
    reasoning: result.reasoning ?? null,
  };
}

function toCsv(rows: CaseRow[]): string {
  const header = Object.keys(rows[0] ?? {});
  return [header, ...rows.map((row) => Object.values(row))]
    .map((cells) => cells.map(csvCell).join(",") + LINE_END)
    .join("");
}

function csvCell(value: unknown): string {
  if (value === null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return CSV_NEEDS_QUOTES.test(text) ? CSV_QUOTE + text.replaceAll(CSV_QUOTE, CSV_QUOTE + CSV_QUOTE) + CSV_QUOTE : text;
}

function toJsonLines(rows: CaseRow[]): string {
  return rows.map((row) => JSON.stringify(row) + LINE_END).join("");
}
