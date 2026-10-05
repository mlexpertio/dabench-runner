import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cmdInit } from "../src/cli/init";
import { PUBLIC_NOTES } from "../src/cli/program";

const SAMPLE_SUITE = "suites/sample.suite.json";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "dabench-init-"));
}

describe("runner init", () => {
  it("starts a suite from the public sample", () => {
    const dir = freshDir();
    cmdInit({ dir }, { command: "dabench", notes: PUBLIC_NOTES });

    expect(readFileSync(join(dir, "suite.json"), "utf8")).toBe(readFileSync(SAMPLE_SUITE, "utf8"));
  });
});
