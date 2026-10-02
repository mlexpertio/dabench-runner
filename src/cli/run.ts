import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { runKey, type RunIdentity, type RunKey } from "../engine/artifact";
import type { CostBasis, LocalAssumptions } from "../engine/calc";
import { sha256File } from "../engine/canonical";
import type { CompletionClient } from "../engine/client";
import { Deployment, hostedApiHost, runDeployment } from "../engine/deployment";
import { pluralize } from "../engine/format";
import { errorMessage } from "../engine/guards";
import { detectHardware } from "../engine/hardware";
import { Harness } from "../engine/harness";
import { createLocalMemoryMonitor, type MemoryMonitor } from "../engine/memory";
import { NO_API_KEY, OpenAICompletionClient } from "../engine/openai-client";
import { fetchEndpoints, pickEndpoint, pinnedParameters, type ServingEndpoint } from "../engine/openrouter-endpoints";
import { discoverProviderModels, type DiscoveredModel } from "../engine/provider-discovery";
import { DEFAULT_BASE_URLS } from "../engine/providers";
import { runBenchmark } from "../engine/runner";
import type { LocalEndpointConfig, OpenAIClientConfig, RunConfig } from "../engine/runconfig";
import { ENGINE_VERSION, type Artifact, type Hardware, type ModelConfig, type ModelRef } from "../engine/schema";
import type { Suite } from "../engine/suite";
import { fail, type Flags } from "./args";
import type { CliHost } from "./program";
import { createProgressReporter, reportRetry } from "./progress";
import {
  completesRun,
  isOpenRouterRun,
  recordedCommand,
  requestedCases,
  resolveRunInputs,
  type RunInputs,
} from "./run-inputs";
import { printRunHeader, printRunSummary } from "./run-report";
import { createLocalRunStore, writeJson, type ResumableRun } from "./run-store";
import { loadSuite } from "./suite-loader";

const RUN_RETRIES = 20;
const RUN_RETRY_MIN_TIMEOUT_MS = 3000;
const RUN_RETRY_MAX_TIMEOUT_MS = 30000;

interface LocalRuntime {
  baseUrl: string | undefined;
  hardware: Hardware;
  memoryMonitor: MemoryMonitor;
  cost: LocalAssumptions;
  modelHash: string | null;
}

interface RunSetting {
  inputs: RunInputs;
  resumable: ResumableRun | null;
  resumeFrom: Artifact | undefined;
  pinned: ServingEndpoint | null;
  local: LocalRuntime | null;
}

export async function cmdRun(flags: Flags, { store: suppliedStore, command }: CliHost): Promise<void> {
  const inputs = resolveRunInputs(flags, command);
  const store = suppliedStore ?? createLocalRunStore(inputs.outPath);
  const { config } = inputs;
  const suite = loadSuite(inputs.suitePath);
  const selectedCases = requestedCases(suite, inputs);

  const client = buildCompletionClient(config);
  const [discovered, pinned, local] = await Promise.all([
    discoverRunModel(config),
    pinServingEndpoint(config, inputs.endpoint),
    prepareLocalRuntime(config, inputs.configDir),
  ]);
  const key = runKey({
    model: runModel(config.model, discovered),
    config: modelConfig(config, discovered, pinned),
    suite,
    modelHash: local ? (local.modelHash ?? discovered?.weightsHash ?? null) : null,
    subset: inputs.subset,
  });
  const resumable = inputs.fresh ? null : await store.findResumableRun(key);
  const resumeFrom = resumable?.artifact ?? undefined;
  const identity = runIdentity(key, { inputs, resumable, resumeFrom, pinned, local });
  const selectedCaseIds = new Set(selectedCases.map(({ testCase }) => testCase.id));
  const recordedSelectedCases =
    resumeFrom?.caseResults.filter((result) => selectedCaseIds.has(result.caseId)).length ?? 0;
  const casesToRun = selectedCases.length - recordedSelectedCases;

  printRunHeader({
    suite,
    categories: inputs.categories,
    subset: inputs.subset ? { name: inputs.subset, cases: selectedCases.length } : null,
    modelId: config.model.id,
    config: key.config,
    discovered,
    pinned,
    local,
    resumed: resumable
      ? { runId: identity.runId, recorded: recordedSelectedCases, selected: selectedCases.length }
      : null,
  });

  await store.beginRun(identity);

  const artifact = await runBenchmark({
    identity,
    client,
    cost: costBasis(config, local, pinned, discovered),
    memoryMonitor: local?.memoryMonitor,
    resumeFrom,
    cases: selectedCases,
    onCheckpoint: async (checkpoint, completed) => {
      await store.checkpointRun(checkpoint, completed);
      if (inputs.outPath && suppliedStore) writeJson(inputs.outPath, checkpoint);
    },
    ...createProgressReporter(),
  });

  if (inputs.outPath && suppliedStore) writeJson(inputs.outPath, artifact);

  if (casesToRun === 0) {
    console.error(`  ↷ skipped all ${selectedCases.length} selected cases because their results are already recorded`);
  }

  printRunSummary(artifact, local !== null);

  if (!completesRun(resumable?.completedAt ?? null, casesToRun)) {
    console.error(`  ✓ ${artifact.runId} was already complete, so its record stays as it was`);
    return;
  }
  console.error("");
  console.error("▸ finalizing the recorded run…");
  await store.completeRun(artifact);
  console.error(
    `  ✓ recorded ${artifact.runId} (${pluralize(artifact.categoryScores.length, "category", "categories")}) · ${store.completionNote(artifact)}`,
  );
}

function runIdentity(key: RunKey, { inputs, resumable, resumeFrom, pinned, local }: RunSetting): RunIdentity {
  const deployment = runDeployment(inputs.config, process.env);
  const hostedHost = deployment === Deployment.Hosted ? hostedApiHost(inputs.config, process.env) : null;
  return {
    ...key,
    runId: resumable?.runId ?? randomUUID(),
    startedAt: resumable?.startedAt ?? new Date().toISOString(),
    hardware: local?.hardware ?? null,
    deployment,
    servingProvider: pinned?.providerName ?? hostedHost,
    reproduceCommand: recordedCommand(inputs.reproduceCommand, {
      pinnedTag: pinned?.tag ?? null,
      categories: scopedCategories(key.suite, inputs.categories, resumeFrom),
      declaredCount: key.suite.categories.length,
    }),
  };
}

function scopedCategories(
  suite: Suite,
  selected: string[] | undefined,
  resumeFrom: Artifact | undefined,
): string[] | undefined {
  if (!selected) return undefined;
  return suite.categories
    .map((category) => category.slug)
    .filter(
      (category) =>
        selected.includes(category) || resumeFrom?.caseResults.some((result) => result.category === category),
    );
}

function runModel(model: ModelRef, discovered: DiscoveredModel | null): ModelRef {
  if (!discovered) return model;
  return {
    ...model,
    name: model.name !== model.id ? model.name : discovered.name,
    metadata: { ...model.metadata, provider: discovered.metadata },
  };
}

function modelConfig(
  config: RunConfig,
  discovered: DiscoveredModel | null,
  pinned: ServingEndpoint | null,
): ModelConfig {
  const { quantization, contextWindow, providerParameters } = config.config;
  return {
    harness: config.openai.harness,
    engineVersion: ENGINE_VERSION,
    quantization: pinned ? pinned.precision : (quantization ?? discovered?.quantization ?? null),
    contextWindow: pinned?.contextWindow ?? contextWindow ?? discovered?.contextWindow ?? null,
    temperature: config.config.temperature,
    mtp: config.config.mtp,
    ...(config.config.nativeJsonSchema ? { nativeJsonSchema: true } : {}),
    providerParameters: pinned ? pinnedParameters(providerParameters, pinned) : providerParameters,
  };
}

async function pinServingEndpoint(config: RunConfig, requested: string | undefined): Promise<ServingEndpoint | null> {
  if (!isOpenRouterRun(config)) return null;
  const { openai, model } = config;
  try {
    const endpoints = await fetchEndpoints({
      baseUrl: openai.baseUrl ?? DEFAULT_BASE_URLS[Harness.OpenRouter],
      modelId: model.id,
      apiKey: process.env[openai.apiKeyEnv],
      headers: openai.headers,
    });
    return pickEndpoint(endpoints, requested);
  } catch (err) {
    fail(`can't pin an OpenRouter endpoint for ${model.id}: ${errorMessage(err)}`);
  }
}

/** A local run is billed on GPU time; a hosted one at the pinned endpoint's price, else the configured or listed one. */
function costBasis(
  config: RunConfig,
  local: LocalRuntime | null,
  pinned: ServingEndpoint | null,
  discovered: DiscoveredModel | null,
): CostBasis {
  if (local) return local.cost;
  return pinned?.pricing ?? config.pricing ?? discovered?.pricing ?? null;
}

async function discoverRunModel(config: RunConfig): Promise<DiscoveredModel | null> {
  if (!config.openai.baseUrl) return null;
  const discovery = discoverProviderModels({
    harness: config.openai.harness,
    baseUrl: config.openai.baseUrl,
    apiKey: process.env[config.openai.apiKeyEnv],
    headers: config.openai.headers,
    modelId: config.model.id,
  });
  if (!discovery) return null;
  try {
    const result = await discovery;
    for (const warning of result.warnings) console.error(`  ⚠ ${warning}`);
    return result.models.find((model) => model.id === config.model.id) ?? result.models[0] ?? null;
  } catch (err) {
    console.error(`  ⚠ provider metadata unavailable: ${errorMessage(err)}`);
    return null;
  }
}

async function prepareLocalRuntime(config: RunConfig, configDir: string): Promise<LocalRuntime | null> {
  if (!config.openai.local) return null;
  const { harness, baseUrl, local } = config.openai;
  const [hardware, modelHash] = await Promise.all([detectHardware(), resolveModelHash(local, configDir)]);
  return {
    baseUrl,
    hardware,
    memoryMonitor: createLocalMemoryMonitor({ harness, baseUrl, modelId: config.model.id }),
    cost: { gpuHourlyUsd: local.gpuHourlyUsd },
    modelHash,
  };
}

async function resolveModelHash(local: LocalEndpointConfig, configDir: string): Promise<string | null> {
  if (local.modelHash) return local.modelHash;
  if (!local.modelPath) return null;
  const path = resolve(configDir, local.modelPath);
  console.error(`  hashing weights ${path} …`);
  try {
    return await sha256File(path);
  } catch (err) {
    fail(`could not hash model weights at ${path}: ${errorMessage(err)}`);
  }
}

function buildCompletionClient(config: RunConfig): CompletionClient {
  const { openai } = config;
  return new OpenAICompletionClient({
    apiKey: resolveApiKey(openai),
    baseUrl: openai.baseUrl,
    defaultHeaders: openai.headers,
    retry: {
      retries: RUN_RETRIES,
      minTimeoutMs: RUN_RETRY_MIN_TIMEOUT_MS,
      maxTimeoutMs: RUN_RETRY_MAX_TIMEOUT_MS,
      onRetry: reportRetry,
    },
  });
}

function resolveApiKey(config: OpenAIClientConfig): string {
  const apiKey = process.env[config.apiKeyEnv];
  if (apiKey) return apiKey;
  if (config.local) return NO_API_KEY;
  fail(`missing ${config.apiKeyEnv} for the OpenAI client.`);
}
