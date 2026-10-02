import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cmdExport, ExportFormat, exportCases } from "dabench/cli/export";
import type { Artifact } from "dabench/engine/schema";

const RUN: Pick<Artifact, "runId" | "model" | "caseResults"> = {
  runId: "run-1",
  model: { id: "acme/x", name: "Acme X", provider: "openrouter" },
  caseResults: [
    {
      caseId: "capital",
      category: "answers",
      graderKind: "exact",
      score: 100,
      correctness: 1,
      quality: 100,
      assertions: [{ name: "exact-match", passed: true }],
      response: 'Paris, "the capital"\nof France',
      finishReason: "stop",
      metrics: {
        tokens: { prompt: 20, completion: 5, reasoning: 0, total: 25 },
        tokensPerSecond: 180.5,
        latencyMs: 500,
        vramMb: null,
      },
    },
    {
      caseId: "booking",
      category: "agents",
      graderKind: "tooltrace",
      score: 40,
      correctness: 0,
      quality: 100,
      assertions: [
        { name: "call[0] get_slot", passed: true },
        { name: "call[1] book_slot", passed: false },
        { name: "reply:decision", passed: false },
      ],
      response: "booked=none",
      reasoning: "No slot fits.",
      finishReason: "stop",
      toolCalls: [{ name: "get_slot", args: { id: "D-1" } }],
      metrics: {
        tokens: { prompt: 900, completion: 120, reasoning: 80, total: 1020 },
        tokensPerSecond: 60,
        latencyMs: 2100,
        vramMb: 5120,
      },
    },
  ],
};

describe("exporting a run's cases", () => {
  it("writes one CSV row per case, quoting text and JSON-encoding lists", () => {
    expect(exportCases(RUN, ExportFormat.Csv)).toBe(
      [
        "run_id,model,case_id,category,grader,passed,score,correctness,quality,failed_assertions,finish_reason," +
          "prompt_tokens,completion_tokens,reasoning_tokens,total_tokens,tokens_per_second,latency_ms,vram_mb," +
          "tool_calls,response,reasoning",
        'run-1,acme/x,capital,answers,exact,true,100,1,100,[],stop,20,5,0,25,180.5,500,,,"Paris, ""the capital""\nof France",',
        'run-1,acme/x,booking,agents,tooltrace,false,40,0,100,"[""call[1] book_slot"",""reply:decision""]",stop,' +
          '900,120,80,1020,60,2100,5120,"[{""name"":""get_slot"",""args"":{""id"":""D-1""}}]",booked=none,No slot fits.',
        "",
      ].join("\n"),
    );
  });

  it("writes the same rows as JSON lines", () => {
    const rows = exportCases(RUN, ExportFormat.Jsonl)
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      run_id: "run-1",
      model: "acme/x",
      case_id: "booking",
      category: "agents",
      grader: "tooltrace",
      passed: false,
      score: 40,
      correctness: 0,
      quality: 100,
      failed_assertions: ["call[1] book_slot", "reply:decision"],
      finish_reason: "stop",
      prompt_tokens: 900,
      completion_tokens: 120,
      reasoning_tokens: 80,
      total_tokens: 1020,
      tokens_per_second: 60,
      latency_ms: 2100,
      vram_mb: 5120,
      tool_calls: [{ name: "get_slot", args: { id: "D-1" } }],
      response: "booked=none",
      reasoning: "No slot fits.",
    });
  });

  it("explains when the file is not a run artifact", () => {
    const path = join(mkdtempSync(join(tmpdir(), "dabench-export-")), "suite.json");
    writeFileSync(path, JSON.stringify({ id: "mybench" }));

    expect(() => cmdExport({ artifact: path })).toThrow(`${path} is not a run artifact`);
  });
});
