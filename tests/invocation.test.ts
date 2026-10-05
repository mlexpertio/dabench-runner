import { describe, expect, it } from "vitest";
import { unsupportedNodeMessage } from "../src/cli/invocation";

describe("supported Node.js versions", () => {
  it("starts at the first release with the SQLite authorizer the SQL grader needs", () => {
    expect(unsupportedNodeMessage("24.9.0")).toBe("dabench needs Node.js 24.10.0 or newer (this is 24.9.0)");
    expect(unsupportedNodeMessage("24.10.0")).toBeUndefined();
    expect(unsupportedNodeMessage("25.0.0")).toBeUndefined();
  });
});
