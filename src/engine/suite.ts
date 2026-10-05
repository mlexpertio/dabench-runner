import { z } from "zod";
import { JsonSchemaSpecSchema } from "./json-schema";
import {
  CategoryDescriptorSchema,
  JsonObjectSchema,
  JsonValueSchema,
  requireUnique,
  ToolCallRecordSchema,
} from "./schema";

const JsonMatchSpecSchema = z.object({
  expected: JsonValueSchema,
  expectedTurns: z.array(JsonValueSchema).min(1).optional(),
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
    z.object({ notContains: z.string().min(1), caseSensitive: z.boolean().optional() }),
    z.object({ regex: z.string().min(1), flags: z.string().optional() }),
  ])
  .superRefine((check, ctx) => {
    if (!("regex" in check)) return;
    try {
      new RegExp(check.regex, check.flags);
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid regular expression" });
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

const CannedToolResultSchema = ToolCallRecordSchema.extend({ result: JsonValueSchema, once: z.boolean().optional() });
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
          args: z.array(JsonValueSchema),
          expected: JsonValueSchema,
        }),
      )
      .min(1),
  })
  .superRefine((spec, ctx) =>
    requireUnique(
      ctx,
      spec.cases.map((c) => c.name),
      "unit-test case name",
      ["cases"],
    ),
  );
export type UnitTestSpec = z.infer<typeof UnitTestSpecSchema>;

const ToolPromptSchema = z.object({ system: z.string().optional(), user: z.string().min(1) }).strict();

const PromptSchema = ToolPromptSchema.extend({
  turns: z.array(z.string().min(1)).min(1).optional(),
}).strict();

export enum RowOrder {
  Ordered = "ordered",
  Unordered = "unordered",
}

const SqlSpecSchema = z
  .object({
    schema: z.string().min(1),
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
  secret: z.string().min(1).optional(),
});

type ToolReference = [path: PropertyKey[], calls: readonly { name: string }[] | undefined];

function requireDeclaredTools(ctx: z.RefinementCtx, tools: readonly { name: string }[], references: ToolReference[]) {
  const names = tools.map((tool) => tool.name);
  requireUnique(ctx, names, "tool name", ["tools"]);
  for (const [path, calls] of references) {
    calls?.forEach((call, index) => {
      if (!names.includes(call.name)) {
        ctx.addIssue({
          code: "custom",
          message: `${JSON.stringify(call.name)} is not among the declared tools`,
          path: [...path, index, "name"],
        });
      }
    });
  }
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
  .superRefine((c, ctx) =>
    requireDeclaredTools(ctx, c.tools, [
      [["expectedTools"], c.expectedTools],
      [["toolResults"], c.toolResults],
      [["forbiddenCalls"], c.forbiddenCalls],
    ]),
  );
export type ToolTraceCase = z.infer<typeof ToolTraceCaseSchema>;

const MAX_STATE_TOOL_CALLS = 31;
const ToolStateCaseSchema = CaseBaseSchema.extend({
  graderKind: z.literal("tool-state"),
  prompt: ToolPromptSchema,
  tools: z.array(ToolDefinitionSchema).min(1),
  environment: z
    .object({
      initialState: JsonObjectSchema,
      actions: z
        .array(
          ToolCallRecordSchema.extend({
            when: JsonObjectSchema.optional(),
            result: JsonValueSchema,
            set: JsonObjectSchema.optional(),
          }).strict(),
        )
        .min(1),
      expectedState: JsonObjectSchema.refine(
        (state) => Object.keys(state).length > 0,
        "expected state must not be empty",
      ),
      maxCalls: z.number().int().min(1).max(MAX_STATE_TOOL_CALLS),
    })
    .strict(),
  forbiddenCalls: z.array(ToolCallRecordSchema).min(1).optional(),
  reply: z.array(RubricCriterionSchema).min(1),
})
  .strict()
  .superRefine((c, ctx) =>
    requireDeclaredTools(ctx, c.tools, [
      [["environment", "actions"], c.environment.actions],
      [["forbiddenCalls"], c.forbiddenCalls],
    ]),
  );
export type ToolStateCase = z.infer<typeof ToolStateCaseSchema>;

const RubricCaseSchema = CaseBaseSchema.extend({
  graderKind: z.literal("rubric"),
  rubric: z.array(RubricCriterionSchema).min(1),
})
  .strict()
  .superRefine((c, ctx) =>
    requireUnique(
      ctx,
      c.rubric.map((criterion) => criterion.id),
      "rubric criterion id",
      ["rubric"],
    ),
  );

export const TestCaseSchema = z.discriminatedUnion("graderKind", [
  CaseBaseSchema.extend({ graderKind: z.literal("exact"), expected: z.string() }).strict(),
  CaseBaseSchema.extend({ graderKind: z.literal("json-match"), jsonMatch: JsonMatchSpecSchema })
    .strict()
    .superRefine((c, ctx) => {
      if (c.jsonMatch.expectedTurns && c.jsonMatch.expectedTurns.length !== (c.prompt.turns?.length ?? 0)) {
        ctx.addIssue({
          code: "custom",
          path: ["jsonMatch", "expectedTurns"],
          message: "one checkpoint is required for each reply before the final turn",
        });
      }
    }),
  ToolTraceCaseSchema,
  ToolStateCaseSchema,
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
    const slugs = suite.categories.map((c) => c.slug);
    requireUnique(ctx, slugs, "category slug", ["categories"]);
    requireUnique(
      ctx,
      suite.cases.map((c) => c.id),
      "case id",
      ["cases"],
    );
    suite.cases.forEach((c, index) => {
      if (!slugs.includes(c.category)) {
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
