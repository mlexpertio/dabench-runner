import { z } from "zod";
import { DEFAULT_GPU_HOURLY_USD, type ApiPricing } from "./calc";
import { Harness } from "./harness";
import { OPENAI_API_KEY_ENV } from "./providers";
import { ModelRefSchema, Sha256HexSchema } from "./schema";

const ApiPricingSchema = z.object({
  promptUsdPerToken: z.number().nonnegative(),
  completionUsdPerToken: z.number().nonnegative(),
}) satisfies z.ZodType<ApiPricing>;

const OpenAIClientConfigSchema = z.object({
  baseUrl: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).default(OPENAI_API_KEY_ENV),
  harness: z.string().min(1).default(Harness.OpenAI),
  headers: z.record(z.string(), z.string()).optional(),
  local: z
    .object({
      gpuHourlyUsd: z.number().positive().default(DEFAULT_GPU_HOURLY_USD),
      modelHash: Sha256HexSchema.optional(),
      modelPath: z.string().min(1).optional(),
    })
    .optional(),
});
export type OpenAIClientConfig = z.infer<typeof OpenAIClientConfigSchema>;
export type LocalEndpointConfig = NonNullable<OpenAIClientConfig["local"]>;

export const RunConfigSchema = z.object({
  suite: z.string().min(1),
  model: ModelRefSchema,
  config: z
    .object({
      quantization: z.string().nullable().default(null),
      contextWindow: z.number().int().positive().nullable().default(null),
      temperature: z.number().nullable().default(null),
      mtp: z.boolean().nullable().default(null),
      nativeJsonSchema: z.boolean().default(false),
      providerParameters: z.record(z.string(), z.json()).default({}),
    })
    .strict(),
  pricing: ApiPricingSchema.optional(),
  openai: OpenAIClientConfigSchema.prefault({}),
});
export type RunConfig = z.infer<typeof RunConfigSchema>;
export type RunConfigInput = z.input<typeof RunConfigSchema>;
