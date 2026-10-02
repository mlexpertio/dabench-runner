import type { Assertion } from "../schema";
import type { RubricCheck, RubricCriterion } from "../suite";
import { FULL_QUALITY, type Grading } from "./verdict";

const REPLY_PREFIX = "reply:";
const STANDALONE_NUMBER = /(?<![\p{L}\d.])\d+(?:,\d{3})*(?:\.\d+)?/gu;
const TEXT_LOCALE = "en-US";

export function gradeRubric(criteria: RubricCriterion[], output: string): Grading {
  const assertions: Assertion[] = [];

  let requiredTotal = 0;
  let requiredPassed = 0;
  let qualityWeight = 0;
  let qualityPassedWeight = 0;

  for (const c of criteria) {
    const passed = runCheck(c.check, output);
    assertions.push({ name: c.id, passed, detail: c.description });
    if (c.required) {
      requiredTotal++;
      if (passed) requiredPassed++;
    } else {
      qualityWeight += c.weight;
      if (passed) qualityPassedWeight += c.weight;
    }
  }

  const correctness = requiredTotal === 0 ? 1 : requiredPassed === requiredTotal ? 1 : 0;
  const quality = qualityWeight === 0 ? FULL_QUALITY : Math.round((qualityPassedWeight / qualityWeight) * FULL_QUALITY);
  return { correctness, quality, assertions };
}

/** Rubric rules on the final reply of a tool-using case, scored on top of its calls. */
export function withReplyChecks(grading: Grading, reply: RubricCriterion[] | undefined, answer: string): Grading {
  if (!reply) return grading;
  const checked = gradeRubric(reply, answer);
  return {
    correctness: grading.correctness * checked.correctness,
    quality: checked.quality,
    assertions: [...grading.assertions, ...checked.assertions.map((a) => ({ ...a, name: `${REPLY_PREFIX}${a.name}` }))],
  };
}

function runCheck(check: RubricCheck, text: string): boolean {
  if ("equals" in check) {
    let actual = text.trim();
    let expected = check.equals.trim();
    if (check.normalizeWhitespace) {
      actual = actual.replace(/\s+/gu, " ");
      expected = expected.replace(/\s+/gu, " ");
    }
    if (check.caseSensitive === false) {
      actual = actual.toLocaleLowerCase(TEXT_LOCALE);
      expected = expected.toLocaleLowerCase(TEXT_LOCALE);
    }
    return actual === expected;
  }
  if ("contains" in check) return includes(text, check.contains, check.caseSensitive);
  if ("containsAll" in check) return check.containsAll.every((s) => includes(text, s, check.caseSensitive));
  if ("containsAny" in check) return check.containsAny.some((s) => includes(text, s, check.caseSensitive));
  if ("notContains" in check) return !includes(text, check.notContains, check.caseSensitive);
  if ("notContainsAny" in check) return check.notContainsAny.every((s) => !includes(text, s, check.caseSensitive));
  if ("regex" in check) return new RegExp(check.regex, check.flags).test(text);
  if ("notRegex" in check) return !new RegExp(check.notRegex, check.flags).test(text);
  if ("minLength" in check) return text.trim().length >= check.minLength;
  if ("maxLength" in check) return text.trim().length <= check.maxLength;
  if ("wordCount" in check) return inRange(countWords(text), check.wordCount);
  if ("lineCount" in check) return inRange(countLines(text), check.lineCount);
  if ("numbersWithin" in check) return numbersIn(text).every((n) => check.numbersWithin.includes(n));
  return false;
}

export function includes(haystack: string, needle: string, caseSensitive = true): boolean {
  return caseSensitive
    ? haystack.includes(needle)
    : haystack.toLocaleLowerCase(TEXT_LOCALE).includes(needle.toLocaleLowerCase(TEXT_LOCALE));
}

function numbersIn(text: string): number[] {
  return [...text.matchAll(STANDALONE_NUMBER)].map((m) => Number(m[0].replaceAll(",", "")));
}

function inRange(value: number, range: { min?: number; max?: number }): boolean {
  return (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);
}

function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

function countLines(text: string): number {
  return text.trim() ? text.trim().split(/\r?\n/u).length : 0;
}
