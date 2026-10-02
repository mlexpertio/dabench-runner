import { z } from "zod";
import { JsonSchemaSpecSchema } from "./json-schema";
import { CategoryDescriptorSchema, ToolCallRecordSchema } from "./schema";

const JsonMatchSpecSchema = z.object({
  expected: z.json(),
  mode: z.literal("exact").default("exact"),
  arrayOrder: z.enum(["ordered", "unordered"]).default("ordered"),
  extraction: z.literal("strict").optional(),
});
export type JsonMatchSpec = z.infer<typeof JsonMatchSpecSchema>;

const RubricCheckSchema = z
  .union([
    z.object({
      equals: z.string(),
      caseSensitive: z.boolean().optional(),
      normalizeWhitespace: z.boolean().optional(),
    }),
    z.object({ contains: z.string().min(1), caseSensitive: z.boolean().optional() }),
    z.object({ containsAll: z.array(z.string().min(1)).min(1), caseSensitive: z.boolean().optional() }),
    z.object({ containsAny: z.array(z.string().min(1)).min(1), caseSensitive: z.boolean().optional() }),
    z.object({ notContains: z.string().min(1), caseSensitive: z.boolean().optional() }),
    z.object({ notContainsAny: z.array(z.string().min(1)).min(1), caseSensitive: z.boolean().optional() }),
    z.object({ regex: z.string().min(1), flags: z.string().optional() }),
    z.object({ notRegex: z.string().min(1), flags: z.string().optional() }),
    z.object({ minLength: z.number().int().nonnegative() }),
    z.object({ maxLength: z.number().int().nonnegative() }),
    z.object({
      wordCount: z.object({
        min: z.number().int().nonnegative().optional(),
        max: z.number().int().nonnegative().optional(),
      }),
    }),
    z.object({
      lineCount: z.object({
        min: z.number().int().nonnegative().optional(),
        max: z.number().int().nonnegative().optional(),
      }),
    }),
    z.object({ numbersWithin: z.array(z.number().nonnegative()) }),
  ])
  .superRefine((check, ctx) => {
    if ("regex" in check || "notRegex" in check) {
      try {
        new RegExp("regex" in check ? check.regex : check.notRegex, check.flags);
      } catch {
        ctx.addIssue({ code: "custom", message: "invalid regular expression" });
      }
    }
    const range = "wordCount" in check ? check.wordCount : "lineCount" in check ? check.lineCount : undefined;
    if (range) {
      if (range.min === undefined && range.max === undefined) {
        ctx.addIssue({ code: "custom", message: "count check requires min or max" });
      }
      if (range.min !== undefined && range.max !== undefined && range.min > range.max) {
        ctx.addIssue({ code: "custom", message: "count min cannot exceed max" });
      }
    }
  });
export type RubricCheck = z.infer<typeof RubricCheckSchema>;

const RubricCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  weight: z.number().positive().default(1),
  required: z.boolean().default(false),
  check: RubricCheckSchema,
});
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;

const ToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: JsonSchemaSpecSchema.optional(),
});

const CannedToolResultSchema = ToolCallRecordSchema.extend({ result: z.json(), once: z.boolean().optional() });
export type CannedToolResult = z.infer<typeof CannedToolResultSchema>;

const ToolTraceOptionsSchema = z.object({
  order: z.literal("strict").default("strict"),
  allowExtraCalls: z.boolean().default(false),
  argumentMatch: z.enum(["subset", "exact"]).default("subset"),
  maxTurns: z.number().int().min(1).max(32).optional(),
});
export type ToolTraceOptions = z.infer<typeof ToolTraceOptionsSchema>;
export const DEFAULT_TOOL_TRACE_OPTIONS = ToolTraceOptionsSchema.parse({});

export const CODE_LANGUAGE = "javascript";
const LINE_END = "\n";

const UnitTestSpecSchema = z
  .object({
    language: z.literal(CODE_LANGUAGE).optional(),
    setup: z.string().min(1).optional(),
    /** The file the model edits. The prompt shows it, and the answer must be SEARCH/REPLACE blocks. */
    editFile: z
      .string()
      .min(1)
      .refine((file) => file.endsWith(LINE_END), "the edit file must end with a newline, as the prompt shows it")
      .optional(),
    entry: z
      .string()
      .regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u, "entry must be an identifier or dotted identifier path"),
    cases: z
      .array(
        z.object({
          name: z.string().min(1),
          args: z.array(z.json()),
          expected: z.json(),
        }),
      )
      .min(1),
  })
  .superRefine((spec, ctx) => {
    const names = spec.cases.map((c) => c.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: "custom", message: "unit-test case names must be unique", path: ["cases"] });
    }
  });
export type UnitTestSpec = z.infer<typeof UnitTestSpecSchema>;

const ToolPromptSchema = z.object({ system: z.string().optional(), user: z.string().min(1) }).strict();

const PromptSchema = ToolPromptSchema.extend({
  /** Scripted follow-up user messages, each sent after the model's previous reply. */
  turns: z.array(z.string().min(1)).min(1).optional(),
}).strict();

export enum RowOrder {
  Ordered = "ordered",
  Unordered = "unordered",
}

const SqlSpecSchema = z
  .object({
    /** DDL shown to the model. */
    schema: z.string().min(1),
    /** INSERT statements the model never sees. */
    seed: z.string().min(1),
    expected: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
    order: z.enum(RowOrder).default(RowOrder.Unordered),
  })
  .strict();
export type SqlSpec = z.infer<typeof SqlSpecSchema>;

const CaseBaseSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  prompt: PromptSchema,
  /** A test string planted in the prompt or tool results; the case fails if it reaches the reply or a tool call. */
  secret: z.string().min(1).optional(),
});

function requireDeclaredTools(
  ctx: z.RefinementCtx,
  declared: ReadonlySet<string>,
  calls: readonly { name: string }[] | undefined,
  field: string,
  what: string,
): void {
  calls?.forEach((call, index) => {
    if (!declared.has(call.name)) {
      ctx.addIssue({
        code: "custom",
        message: `${what} ${JSON.stringify(call.name)} is not among the declared tools`,
        path: [field, index, "name"],
      });
    }
  });
}

const ToolTraceCaseSchema = CaseBaseSchema.extend({
  graderKind: z.literal("tooltrace"),
  prompt: ToolPromptSchema,
  tools: z.array(ToolDefinitionSchema).min(1),
  expectedTools: z.array(ToolCallRecordSchema),
  toolOptions: ToolTraceOptionsSchema.optional(),
  toolResults: z.array(CannedToolResultSchema).min(1).optional(),
  forbiddenCalls: z.array(ToolCallRecordSchema).min(1).optional(),
  reply: z.array(RubricCriterionSchema).min(1).optional(),
})
  .strict()
  .superRefine((c, ctx) => {
    const names = c.tools.map((t) => t.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: "custom", message: "tool names must be unique", path: ["tools"] });
    }
    const declared = new Set(names);
    requireDeclaredTools(ctx, declared, c.expectedTools, "expectedTools", "expected call");
    requireDeclaredTools(ctx, declared, c.toolResults, "toolResults", "tool result");
    requireDeclaredTools(ctx, declared, c.forbiddenCalls, "forbiddenCalls", "forbidden call");
  });
export type ToolTraceCase = z.infer<typeof ToolTraceCaseSchema>;

const RubricCaseSchema = CaseBaseSchema.extend({
  graderKind: z.literal("rubric"),
  rubric: z.array(RubricCriterionSchema).min(1),
})
  .strict()
  .superRefine((c, ctx) => {
    const ids = c.rubric.map((criterion) => criterion.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "rubric criterion IDs must be unique", path: ["rubric"] });
    }
  });

export const TestCaseSchema = z.discriminatedUnion("graderKind", [
  CaseBaseSchema.extend({ graderKind: z.literal("exact"), expected: z.string() }).strict(),
  CaseBaseSchema.extend({ graderKind: z.literal("json-match"), jsonMatch: JsonMatchSpecSchema }).strict(),
  CaseBaseSchema.extend({ graderKind: z.literal("schema"), schema: JsonSchemaSpecSchema }).strict(),
  ToolTraceCaseSchema,
  CaseBaseSchema.extend({ graderKind: z.literal("unit-test"), unitTests: UnitTestSpecSchema }).strict(),
  RubricCaseSchema,
  CaseBaseSchema.extend({ graderKind: z.literal("sql"), sql: SqlSpecSchema }).strict(),
]);
export type TestCase = z.infer<typeof TestCaseSchema>;

export const SuiteSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    categories: z.array(CategoryDescriptorSchema).min(1),
    cases: z.array(TestCaseSchema).min(1),
  })
  .superRefine((suite, ctx) => {
    const slugs = new Set<string>();
    suite.categories.forEach((c, index) => {
      if (slugs.has(c.slug)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate category slug ${JSON.stringify(c.slug)}`,
          path: ["categories", index, "slug"],
        });
      }
      slugs.add(c.slug);
    });

    const ids = new Set<string>();
    suite.cases.forEach((c, index) => {
      if (ids.has(c.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate case id ${JSON.stringify(c.id)}`,
          path: ["cases", index, "id"],
        });
      }
      ids.add(c.id);
      if (!slugs.has(c.category)) {
        ctx.addIssue({
          code: "custom",
          message: `case ${JSON.stringify(c.id)} uses category ${JSON.stringify(c.category)}, which the suite does not declare in \`categories\``,
          path: ["cases", index, "category"],
        });
      }
    });

    const withCases = new Set(suite.cases.map((c) => c.category));
    suite.categories.forEach((c, index) => {
      if (!withCases.has(c.slug)) {
        ctx.addIssue({
          code: "custom",
          message: `category ${JSON.stringify(c.slug)} has no cases; add some or remove it from \`categories\``,
          path: ["categories", index, "slug"],
        });
      }
    });
  });
export type Suite = z.infer<typeof SuiteSchema>;

export function caseGradingContent(testCase: TestCase): Record<string, unknown> {
  const { id: _id, category: _category, tier: _tier, ...gradingContent } = testCase;
  return gradingContent;
}
