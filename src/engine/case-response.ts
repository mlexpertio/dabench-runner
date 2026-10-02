import type { ToolCallRecord } from "./schema";

const CALLS_SEPARATOR = "\n\n";

/** The recorded response: a tool-calling case's calls as one JSON line, then the reply the model wrote after them. */
export function caseResponse(text: string, calls: readonly ToolCallRecord[] | undefined): string {
  if (!calls || calls.length === 0) return text;
  const line = JSON.stringify(calls.map((call) => ({ name: call.name, arguments: call.args ?? {} })));
  return text ? `${line}${CALLS_SEPARATOR}${text}` : line;
}

/** The reply after the calls line, or the whole response when it doesn't open with one. */
export function replyText(response: string, calls: readonly ToolCallRecord[] | undefined): string {
  if (!calls || calls.length === 0) return response;
  const end = response.indexOf(CALLS_SEPARATOR);
  const head = end === -1 ? response : response.slice(0, end);
  if (!isCallsLine(head, calls.length)) return response;
  return end === -1 ? "" : response.slice(end + CALLS_SEPARATOR.length);
}

function isCallsLine(line: string, callCount: number): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    return Array.isArray(parsed) && parsed.length === callCount;
  } catch {
    return false;
  }
}
