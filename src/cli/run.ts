import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { artifactHeader, runKey, type RunIdentity } from "../engine/artifact";
import { sha256File } from "../engine/canonical";
import type { CompletionClient } from "../engine/client";
import { pluralize } from "../engine/format";
import { errorMessage } from "../engine/guards";
import { DEFAULT_BASE_URLS, Harness } from "../engine/harness";
import { OpenAICompletionClient } from "../engine/openai-client";
import { fetchEndpoints, pickEndpoint, type ServiceTier, type ServingEndpoint } from "../engine/openrouter-endpoints";
import { discoverProviderModels, type DiscoveredModel } from "../engine/provider-discovery";
import { runBenchmark, type MemoryMonitor } from "../engine/runner";
import { Deployment, type Hardware } from "../engine/schema";
import { fail, loadSuite, type Flags } from "./args";
import { detectHardware } from "./hardware";
import { createLocalMemoryMonitor } from "./memory";
import type { CliHost } from "./program";
import { createProgressReporter, reportRetry } from "./progress";
import { runSubject, servingTarget, type LocalEndpointConfig, type RunConfig } from "./run-config";
import { recordedCommand, resolveRunInputs } from "./run-inputs";
import { printRunHeader, printRunSummary } from "./run-report";
import { createLocalRunStore, writeJson } from "./run-store";

const RUN_RETRIES = 20;
const RUN_RETRY_MIN_TIMEOUT_MS = 3000;
const RUN_RETRY_MAX_TIMEOUT_MS = 30000;

interface ThisMachine {
  hardware: Hardware;
  memoryMonitor: MemoryMonitor;
}

export async function cmdRun(flags: Flags, host: CliHost): Promise<void> {
  const inputs = resolveRunInputs(flags, host.command);
  const store = host.store ?? createLocalRunStore(inputs.outPath);
  const extraArtifactFile = host.store ? inputs.outPath : undefined;
  const { config } = inputs;
  const { local: localEndpoint } = config.openai;
  const suite = loadSuite(inputs.suitePath);
  const target = servingTarget(config, process.env);

  const client = buildCompletionClient(config);
  const [discovered, pinned, modelHash, machine] = await Promise.all([
    discoverRunModel(config),
    inputs.serviceTier ? pinServingEndpoint(config, inputs.serviceTier, inputs.endpoint) : null,
    localEndpoint ? resolveModelHash(localEndpoint, inputs.configDir) : null,
    target.onThisMachine ? inspectThisMachine(config, target.url) : null,
  ]);
  const local = localEndpoint ? { gpuHourlyUsd: localEndpoint.gpuHourlyUsd, modelHash } : null;
  const subject = runSubject(config, { discovered, pinned, local });
  const key = runKey({
    model: subject.model,
    config: subject.config,
    suite,
    modelHash: subject.modelHash,
  });
  const resumable = inputs.fresh ? null : await store.findResumableRun(key);
  const resumeFrom = resumable?.artifact ?? undefined;
  const identity: RunIdentity = {
    ...key,
    runId: resumable?.runId ?? randomUUID(),
    startedAt: resumable?.startedAt ?? new Date().toISOString(),
    hardware: machine?.hardware ?? null,
    deployment: target.deployment,
    servingProvider: pinned?.providerName ?? (target.deployment === Deployment.Hosted ? target.url.hostname : null),
    reproduceCommand: recordedCommand(inputs.reproduceCommand, pinned?.tag ?? null),
  };
  const recordedCases = resumeFrom?.caseResults.length ?? 0;
  const casesToRun = suite.cases.length - recordedCases;

  printRunHeader({
    suite,
    modelId: config.model.id,
    config: key.config,
    discovered,
    pinned,
    local: localEndpoint ? { baseUrl: config.openai.baseUrl, gpuHourlyUsd: localEndpoint.gpuHourlyUsd } : null,
    hardware: identity.hardware,
    resumed: resumable ? { runId: identity.runId, recorded: recordedCases } : null,
  });

  await store.beginRun(artifactHeader(identity));

  const artifact = await runBenchmark({
    identity,
    client,
    cost: subject.cost,
    memoryMonitor: machine?.memoryMonitor,
    resumeFrom,
    onCheckpoint: async (checkpoint, completed) => {
      await store.checkpointRun(checkpoint, completed);
      if (extraArtifactFile) writeJson(extraArtifactFile, checkpoint);
    },
    ...createProgressReporter(),
  });

  if (casesToRun === 0) {
    console.error(`  ↷ skipped all ${suite.cases.length} cases because their results are already recorded`);
  }

  printRunSummary(artifact, localEndpoint !== undefined);

  if (casesToRun === 0 && resumable?.completedAt) {
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

async function pinServingEndpoint(
  config: RunConfig,
  tier: ServiceTier,
  requested: string | undefined,
): Promise<ServingEndpoint> {
  const { openai, model } = config;
  try {
    const endpoints = await fetchEndpoints({
      baseUrl: openai.baseUrl ?? DEFAULT_BASE_URLS[Harness.OpenRouter],
      modelId: model.id,
      apiKey: process.env[openai.apiKeyEnv],
      headers: openai.headers,
    });
    return pickEndpoint(endpoints, tier, requested);
  } catch (err) {
    fail(`can't pin an OpenRouter endpoint for ${model.id}: ${errorMessage(err)}`);
  }
}

async function discoverRunModel(config: RunConfig): Promise<DiscoveredModel | null> {
  const { harness, baseUrl, apiKeyEnv, headers } = config.openai;
  if (!baseUrl) return null;
  try {
    const result = await discoverProviderModels({
      harness,
      baseUrl,
      apiKey: process.env[apiKeyEnv],
      headers,
      modelId: config.model.id,
    });
    for (const warning of result.warnings) console.error(`  ⚠ ${warning}`);
    return result.models.find((model) => model.id === config.model.id) ?? result.models[0] ?? null;
  } catch (err) {
    console.error(`  ⚠ provider metadata unavailable: ${errorMessage(err)}`);
    return null;
  }
}

async function inspectThisMachine(config: RunConfig, server: URL): Promise<ThisMachine> {
  return {
    hardware: await detectHardware(),
    memoryMonitor: createLocalMemoryMonitor({ harness: config.openai.harness, modelId: config.model.id, server }),
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

function buildCompletionClient({ openai }: RunConfig): CompletionClient {
  const apiKey = process.env[openai.apiKeyEnv];
  if (!apiKey && !openai.local) fail(`missing ${openai.apiKeyEnv} for the OpenAI client.`);
  return new OpenAICompletionClient({
    apiKey,
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
