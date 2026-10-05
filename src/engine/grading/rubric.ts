import type { RubricCheck, RubricCriterion } from "../suite";
import { FULL_QUALITY, type Grading } from "./verdict";

const TEXT_LOCALE = "en-US";

export function gradeRubric(criteria: RubricCriterion[], output: string): Grading {
  const checked = criteria.map((criterion) => ({ criterion, passed: runCheck(criterion.check, output) }));
  const optional = checked.filter(({ criterion }) => !criterion.required);
  const weightOf = (items: typeof checked) => items.reduce((sum, { criterion }) => sum + criterion.weight, 0);
  const optionalWeight = weightOf(optional);
  return {
    correctness: checked.every(({ criterion, passed }) => passed || !criterion.required) ? 1 : 0,
    quality:
      optionalWeight === 0
        ? FULL_QUALITY
        : Math.round((weightOf(optional.filter(({ passed }) => passed)) / optionalWeight) * FULL_QUALITY),
    assertions: checked.map(({ criterion, passed }) => ({ name: criterion.id, passed, detail: criterion.description })),
  };
}

function runCheck(check: RubricCheck, text: string): boolean {
  if ("equals" in check) {
    const normalized = (value: string) => {
      const spaced = check.normalizeWhitespace ? value.trim().replace(/\s+/gu, " ") : value.trim();
      return check.caseSensitive === false ? spaced.toLocaleLowerCase(TEXT_LOCALE) : spaced;
    };
    return normalized(text) === normalized(check.equals);
  }
  if ("contains" in check) return includes(text, check.contains, check.caseSensitive);
  if ("notContains" in check) return !includes(text, check.notContains, check.caseSensitive);
  return new RegExp(check.regex, check.flags).test(text);
}

export function includes(haystack: string, needle: string, caseSensitive = true): boolean {
  return caseSensitive
    ? haystack.includes(needle)
    : haystack.toLocaleLowerCase(TEXT_LOCALE).includes(needle.toLocaleLowerCase(TEXT_LOCALE));
}
