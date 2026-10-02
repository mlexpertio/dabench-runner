import { canonicalize } from "./canonical";
import type { ToolCallRecord } from "./schema";
import type { ToolTraceOptions } from "./suite";

/** A call matches a rule with the same name whose args it contains, or, under exact matching, equals. */
export function callMatches(
  rule: ToolCallRecord,
  call: ToolCallRecord,
  argumentMatch: ToolTraceOptions["argumentMatch"] = "subset",
): boolean {
  if (rule.name !== call.name) return false;
  return argumentMatch === "exact"
    ? canonicalize(rule.args ?? {}) === canonicalize(call.args ?? {})
    : isDeepSubset(rule.args ?? {}, call.args ?? {});
}

export function isDeepSubset(expected: unknown, actual: unknown): boolean {
  if (canonicalize(expected) === canonicalize(actual)) return true;
  if (!expected || !actual || typeof expected !== "object" || typeof actual !== "object") return false;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) && expected.length <= actual.length && expected.every((v, i) => isDeepSubset(v, actual[i]))
    );
  }
  if (Array.isArray(actual)) return false;
  return Object.entries(expected as Record<string, unknown>).every(
    ([key, value]) => Object.hasOwn(actual, key) && isDeepSubset(value, (actual as Record<string, unknown>)[key]),
  );
}
