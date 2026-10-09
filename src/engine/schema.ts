import { z } from "zod";
import { isJsonObject, isJsonValue, type JsonObject, type JsonValue } from "./guards";

export const ARTIFACT_SCHEMA_VERSION = "1.0.0" as const;
export const ENGINE_VERSION = "1.0.0";

export enum Deployment {
  Hosted = "hosted",
  Local = "local",
}

export const JsonValueSchema = z.custom<JsonValue>(isJsonValue, "expected a JSON value");
export const JsonObjectSchema = z.custom<JsonObject>(isJsonObject, "expected a JSON object");

export function requireUnique(
  ctx: z.RefinementCtx,
  values: readonly string[],
  what: string,
  path: PropertyKey[],
): void {
  values.forEach((value, index) => {
    if (values.indexOf(value) !== index) {
      ctx.addIssue({ code: "custom", message: `duplicate ${what} ${JSON.stringify(value)}`, path: [...path, index] });
    }
  });
}

export const Sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected a 64-character lowercase sha256 hex digest");

const isoTimestamp = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "expected an ISO-8601 timestamp");

export const GraderKind = z.enum([
  "exact",
  "json-match",
  "schema",
  "tooltrace",
  "tool-state",
  "unit-test",
  "rubric",
  "sql",
]);
export type GraderKind = z.infer<typeof GraderKind>;

const AssertionSchema = z.object({
  name: z.string().min(1),
  passed: z.boolean(),
  detail: z.string().optional(),
});
export type Assertion = z.infer<typeof AssertionSchema>;

const TokenCountsSchema = z.object({
  prompt: z.number().int().nonnegative(),
  completion: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
const CaseMetricsSchema = z.object({
  tokens: TokenCountsSchema,
  tokensPerSecond: z.number().nonnegative(),
  latencyMs: z.number().nonnegative(),
  vramMb: z.number().nonnegative().nullable(),
});
export type CaseMetrics = z.infer<typeof CaseMetricsSchema>;

export const ToolCallRecordSchema = z.object({
  name: z.string().min(1),
  args: JsonObjectSchema.optional(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

const CaseResultSchema = z.object({
  caseId: z.string().min(1),
  category: z.string().min(1),
  graderKind: GraderKind,
  score: z.number().min(0).max(100),
  correctness: z.number().min(0).max(1),
  quality: z.number().min(0).max(100),
  assertions: z.array(AssertionSchema),
  response: z.string(),
  reasoning: z.string().optional(),
  finishReason: z.string().nullable(),
  toolCalls: z.array(ToolCallRecordSchema).optional(),
  metrics: CaseMetricsSchema,
});
export type CaseResult = z.infer<typeof CaseResultSchema>;

const ReasoningEffortSchema = z.enum(["medium", "high"]);

export const GENERATION_PROFILES = [
  { reasoningTokens: 2048, reasoningEffort: "medium", maxOutputTokens: 4096 },
  { reasoningTokens: 4096, reasoningEffort: "high", maxOutputTokens: 8192 },
] as const satisfies readonly {
  reasoningTokens: number;
  reasoningEffort: z.infer<typeof ReasoningEffortSchema>;
  maxOutputTokens: number;
}[];

const CategoryGenerationSchema = z
  .object({
    reasoningTokens: z.literal(GENERATION_PROFILES.map((profile) => profile.reasoningTokens)),
    reasoningEffort: ReasoningEffortSchema,
    maxOutputTokens: z.number().int().positive(),
  })
  .superRefine((generation, ctx) => {
    const profile = GENERATION_PROFILES.find((p) => p.reasoningTokens === generation.reasoningTokens);
    if (profile && generation.reasoningEffort !== profile.reasoningEffort) {
      ctx.addIssue({
        code: "custom",
        message: `${generation.reasoningTokens} reasoning tokens require ${profile.reasoningEffort} effort fallback`,
        path: ["reasoningEffort"],
      });
    }
    if (generation.maxOutputTokens <= generation.reasoningTokens) {
      ctx.addIssue({
        code: "custom",
        message: "max output tokens must leave room for an answer after reasoning",
        path: ["maxOutputTokens"],
      });
    }
  });
export type CategoryGeneration = z.infer<typeof CategoryGenerationSchema>;

export const CategoryDescriptorSchema = z.object({
  slug: z.string().min(1),
  label: z.string().min(1),
  short: z.string().min(1),
  generation: CategoryGenerationSchema,
});
export type CategoryDescriptor = z.infer<typeof CategoryDescriptorSchema>;

const CategoryScoreSchema = z.object({
  category: z.string().min(1),
  score: z.number().min(0).max(100),
  caseCount: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(1),
});
export type CategoryScore = z.infer<typeof CategoryScoreSchema>;

export const ModelRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  metadata: z.record(z.string(), z.json()).optional(),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

const ModelConfigSchema = z.object({
  harness: z.string().min(1),
  engineVersion: z.string().min(1),
  quantization: z.string().nullable(),
  contextWindow: z.number().int().positive().nullable(),
  temperature: z.number().nullable(),
  mtp: z.boolean().nullable(),
  providerParameters: z.record(z.string(), z.json()).optional(),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

const SuiteRefSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  hash: Sha256HexSchema,
});
export type SuiteRef = z.infer<typeof SuiteRefSchema>;

const MemoryKindSchema = z.enum(["vram", "unified-ram", "system-ram"]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

const MemoryUsageSchema = z.object({
  kind: MemoryKindSchema,
  peakMb: z.number().nonnegative(),
  avgMb: z.number().nonnegative(),
  samples: z.number().int().positive(),
  source: z.string().min(1),
});
export type MemoryUsage = z.infer<typeof MemoryUsageSchema>;

const MetricsSchema = z.object({
  tokens: TokenCountsSchema,
  tokensPerSecond: z.number().nonnegative(),
  avgTokensPerSecond: z.number().nonnegative(),
  avgCompletionTokens: z.number().nonnegative(),
  avgReasoningTokens: z.number().nonnegative(),
  latencyMs: z.number().nonnegative(),
  vramMb: z.number().nonnegative().nullable(),
  memory: MemoryUsageSchema.nullable().optional(),
});
export type Metrics = z.infer<typeof MetricsSchema>;

const CostSchema = z.object({
  amountUsd: z.number().nonnegative(),
  currency: z.literal("USD"),
  estimated: z.boolean(),
});
export type Cost = z.infer<typeof CostSchema>;

const AcceleratorSchema = z.object({
  kind: z.enum(["cuda", "metal"]),
  name: z.string().min(1),
  memoryMb: z.number().nonnegative().nullable(),
});
export type Accelerator = z.infer<typeof AcceleratorSchema>;

const HardwareSchema = z.object({
  platform: z.string().min(1),
  arch: z.string().min(1),
  osVersion: z.string().nullable(),
  cpuModel: z.string().nullable(),
  cpuCores: z.number().int().positive().nullable(),
  totalRamMb: z.number().nonnegative(),
  accelerators: z.array(AcceleratorSchema),
  memoryModel: z.enum(["discrete-vram", "unified", "cpu-only"]),
});
export type Hardware = z.infer<typeof HardwareSchema>;

const RunSchema = z.object({
  timestamp: isoTimestamp,
  engineVersion: z.string().min(1),
  hardware: HardwareSchema.nullable().optional(),
  deployment: z.enum(Deployment),
  servingProvider: z.string().min(1).nullable(),
});
const ReproduceSchema = z.object({
  command: z.string().min(1),
  suiteRef: z.string().min(1),
  suiteHash: Sha256HexSchema,
  configHash: Sha256HexSchema,
  caseHashes: z.array(Sha256HexSchema),
  modelHash: Sha256HexSchema.nullable().optional(),
});

export const ArtifactSchema = z.object({
  schemaVersion: z.literal(ARTIFACT_SCHEMA_VERSION),
  runId: z.string().min(1),
  model: ModelRefSchema,
  config: ModelConfigSchema,
  suite: SuiteRefSchema,
  categories: z.array(CategoryDescriptorSchema).min(1),
  categoryScores: z.array(CategoryScoreSchema).min(1),
  caseResults: z.array(CaseResultSchema).min(1),
  metrics: MetricsSchema,
  cost: CostSchema,
  run: RunSchema,
  reproduce: ReproduceSchema,
});
export type Artifact = z.infer<typeof ArtifactSchema>;
