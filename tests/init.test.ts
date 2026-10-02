import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cmdInit } from "dabench/cli/init";
import { PUBLIC_NOTES } from "dabench/cli/program";
import { loadSuite } from "dabench/cli/suite-loader";

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

describe("suite loading", () => {
  it("reads suites as JSON and never runs them as code", () => {
    const path = join(freshDir(), "suite.ts");
    writeFileSync(path, 'export default { id: "s", version: "v1", categories: [], cases: [] };\n');

    expect(() => loadSuite(path)).toThrow(`${path} is not a JSON suite`);
  });
});
