import { describe, expect, it } from "vitest";
import { invokedCommand, unsupportedNodeMessage } from "dabench/cli/invocation";

describe("the command the CLI prints and records", () => {
  it("is the one the user started it with", () => {
    expect(invokedCommand({ npm_lifecycle_event: "npx" })).toBe("npx dabench");
    expect(invokedCommand({ npm_lifecycle_event: "engine" })).toBe("npm run engine --");
    expect(invokedCommand({})).toBe("dabench");
  });
});

describe("supported Node.js versions", () => {
  it("starts at the first release with the SQLite authorizer the SQL grader needs", () => {
    expect(unsupportedNodeMessage("24.9.0")).toBe("dabench needs Node.js 24.10.0 or newer (this is 24.9.0)");
    expect(unsupportedNodeMessage("24.10.0")).toBeUndefined();
    expect(unsupportedNodeMessage("25.0.0")).toBeUndefined();
  });
});
