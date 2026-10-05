import { canonicalize, sortedByCanonical } from "../canonical";
import { extractEmbeddedJson } from "../extract";
import type { Assertion } from "../schema";
import type { JsonMatchSpec } from "../suite";
import { assertion, failedGate, FULL_QUALITY, preview, previewJson, WIDE_PREVIEW_CHARS, type Grading } from "./verdict";

const EXACT_MATCH = "exact-match";
const JSON_PARSES = "json-parses";
const RESPONSE_FORMAT = "response-format";
const EMBEDDED_FORMAT_QUALITY = 70;

export function gradeExact(expected: string, output: string): Grading {
  const want = expected.trim();
  const got = output.trim();
  const passed = got === want;
  return {
    correctness: passed ? 1 : 0,
    quality: FULL_QUALITY,
    assertions: [
      assertion(EXACT_MATCH, passed, `expected ${JSON.stringify(preview(want))}, got ${JSON.stringify(preview(got))}`),
    ],
  };
}

export function gradeJsonMatch(spec: JsonMatchSpec, output: string): Grading {
  const json = parseWithFormat(output);
  if (!json.ok) return failedGate(JSON_PARSES, json.error);

  const comparable = spec.arrayOrder === "unordered" ? sortArrays : (value: unknown) => value;
  const passed = canonicalize(comparable(spec.expected)) === canonicalize(comparable(json.value));
  return {
    correctness: passed ? 1 : 0,
    quality: json.quality,
    assertions: [
      assertion(JSON_PARSES, true),
      json.format,
      assertion(
        `json-${spec.mode}`,
        passed,
        `expected ${previewJson(spec.expected, WIDE_PREVIEW_CHARS)}, got ${previewJson(json.value, WIDE_PREVIEW_CHARS)}`,
      ),
    ],
  };
}

function sortArrays(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return sortedByCanonical(value.map(sortArrays));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sortArrays(item)]));
}

type FormattedJson = { ok: true; value: unknown; quality: number; format: Assertion } | { ok: false; error: string };

function parseWithFormat(output: string): FormattedJson {
  try {
    return {
      ok: true,
      value: JSON.parse(output.trim()),
      quality: FULL_QUALITY,
      format: assertion(RESPONSE_FORMAT, true),
    };
  } catch {}
  const embedded = extractEmbeddedJson(output);
  if (!embedded.ok) return embedded;
  return {
    ...embedded,
    quality: EMBEDDED_FORMAT_QUALITY,
    format: assertion(
      RESPONSE_FORMAT,
      false,
      "answer contains valid JSON but is not a single bare JSON value (fences or prose around it)",
    ),
  };
}
