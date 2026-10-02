import { pluralize } from "../engine/format";
import { requireFlag, type Flags } from "./args";
import { loadSuite } from "./suite-loader";

export enum ValidateFlag {
  Suite = "suite",
}

export function cmdValidate(flags: Flags): void {
  const suite = loadSuite(requireFlag(flags, ValidateFlag.Suite));

  const byCategory = countBy(suite.cases.map((c) => c.category));
  const byKind = countBy(suite.cases.map((c) => c.graderKind));

  console.error(`✓ ${suite.id}@${suite.version}: ${pluralize(suite.cases.length, "case")}`);
  console.error("  categories, in display order:");
  suite.categories.forEach((cat, i) => {
    console.error(
      `    · ${String(i + 1).padStart(2)}. ${cat.slug}: ${cat.label} (${cat.short}): ${byCategory.get(cat.slug)}` +
        ` · reasoning ${cat.generation.reasoningTokens}/${cat.generation.reasoningEffort}` +
        ` · total ${cat.generation.maxOutputTokens}/call`,
    );
  });
  console.error("  grader kinds:");
  for (const [kind, n] of byKind) console.error(`    · ${kind}: ${n}`);
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}
