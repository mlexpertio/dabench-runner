import { z } from "zod";
import type { ApiPricing, CostBasis } from "../engine/calc";
import {
  Harness,
  isLocalHarness,
  knownHarness,
  OPENAI_API_KEY_ENV,
  OPENAI_API_URL,
  OPENAI_BASE_URL_ENV,
} from "../engine/harness";
import type { ServingEndpoint } from "../engine/openrouter-endpoints";
import type { DiscoveredModel } from "../engine/provider-discovery";
import {
  Deployment,
  ENGINE_VERSION,
  ModelRefSchema,
  Sha256HexSchema,
  type ModelConfig,
  type ModelRef,
} from "../engine/schema";
import { pinnedParameters } from "../engine/openrouter-endpoints";

const DEFAULT_GPU_HOURLY_USD = 0.5;
const LOOPBACK_HOSTS = new Set(["localhost", "0.0.0.0", "[::1]", "::1"]);
const LOOPBACK_IPV4 = /^127\./;
const LOOPBACK_SUFFIX = ".localhost";
const LAN_SUFFIX = ".local";
const PRIVATE_IPV4 = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

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
      providerParameters: z.record(z.string(), z.json()).default({}),
    })
    .strict(),
  pricing: ApiPricingSchema.optional(),
  openai: OpenAIClientConfigSchema.prefault({}),
});
export type RunConfig = z.infer<typeof RunConfigSchema>;
export type RunConfigInput = z.input<typeof RunConfigSchema>;

type Env = Record<string, string | undefined>;

export interface ServingTarget {
  deployment: Deployment;
  url: URL;
  onThisMachine: boolean;
}

export function servingTarget(config: RunConfig, env: Env): ServingTarget {
  const { harness, local, baseUrl } = config.openai;
  const url = new URL(baseUrl ?? env[OPENAI_BASE_URL_ENV] ?? OPENAI_API_URL);
  return {
    deployment:
      knownHarness(harness) === Harness.OpenRouter
        ? Deployment.Hosted
        : isLocalHarness(harness) || local || isOnLocalNetwork(url.hostname)
          ? Deployment.Local
          : Deployment.Hosted,
    url,
    onThisMachine: local !== undefined && isLoopbackHost(url.hostname),
  };
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || LOOPBACK_IPV4.test(host) || host.endsWith(LOOPBACK_SUFFIX);
}

function isOnLocalNetwork(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return isLoopbackHost(host) || PRIVATE_IPV4.test(host) || host.endsWith(LAN_SUFFIX);
}

interface RunFacts {
  discovered: DiscoveredModel | null;
  pinned: ServingEndpoint | null;
  local: { gpuHourlyUsd: number; modelHash: string | null } | null;
}

export interface RunSubject {
  model: ModelRef;
  config: ModelConfig;
  modelHash: string | null;
  cost: CostBasis;
}

export function runSubject(config: RunConfig, { discovered, pinned, local }: RunFacts): RunSubject {
  const { quantization, contextWindow, temperature, mtp, providerParameters } = config.config;
  const { model } = config;
  return {
    model: model.name === model.id && discovered?.name ? { ...model, name: discovered.name } : model,
    config: {
      harness: config.openai.harness,
      engineVersion: ENGINE_VERSION,
      quantization: pinned ? pinned.precision : (quantization ?? discovered?.quantization ?? null),
      contextWindow: pinned?.contextWindow ?? contextWindow ?? discovered?.contextWindow ?? null,
      temperature,
      mtp,
      providerParameters: pinned ? pinnedParameters(providerParameters, pinned) : providerParameters,
    },
    modelHash: local ? (local.modelHash ?? discovered?.weightsHash ?? null) : null,
    cost: local
      ? { gpuHourlyUsd: local.gpuHourlyUsd }
      : (pinned?.pricing ?? config.pricing ?? discovered?.pricing ?? null),
  };
}
