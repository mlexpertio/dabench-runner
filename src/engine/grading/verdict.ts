import type { Assertion } from "../schema";

export interface Grading {
  correctness: number;
  quality: number;
  assertions: Assertion[];
}

export function assertion(name: string, passed: boolean, failDetail?: string): Assertion {
  return passed || failDetail === undefined ? { name, passed } : { name, passed, detail: failDetail };
}

export const FULL_QUALITY = 100;
const PREVIEW_CHARS = 80;
export const WIDE_PREVIEW_CHARS = 160;

/** The gate failed, so every check that depends on it fails with it. */
export function failedGate(gate: string, detail: string, dependents: string[] = [], dependentDetail = ""): Grading {
  return {
    correctness: 0,
    quality: FULL_QUALITY,
    assertions: [assertion(gate, false, detail), ...dependents.map((name) => assertion(name, false, dependentDetail))],
  };
}

export function preview(text: string, maxChars = PREVIEW_CHARS): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

export function previewJson(value: unknown, maxChars = PREVIEW_CHARS): string {
  return preview(JSON.stringify(value) ?? "undefined", maxChars);
}
