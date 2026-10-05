import { describe, expect, it } from "vitest";
import { RunConfigSchema, runSubject, servingTarget, type RunConfig } from "../src/cli/run-config";
import { Harness } from "../src/engine/harness";
import { ServiceTier, type ServingEndpoint } from "../src/engine/openrouter-endpoints";
import type { DiscoveredModel } from "../src/engine/provider-discovery";
import { Deployment } from "../src/engine/schema";

const NO_ENV = {};
const PRICING = { promptUsdPerToken: 1e-6, completionUsdPerToken: 2e-6 };

function runConfig(harness: Harness, openai: object = {}, config: object = {}): RunConfig {
  return RunConfigSchema.parse({
    suite: "suite.json",
    model: { id: "acme/model", name: "acme/model", provider: harness },
    config,
    openai: { harness, ...openai },
  });
}

const llamaCppAt = (baseUrl: string) => runConfig(Harness.LlamaCpp, { baseUrl, local: {} });

describe("servingTarget", () => {
  it.each([
    ["an OpenRouter run", runConfig(Harness.OpenRouter), NO_ENV, Deployment.Hosted, false],
    ["llama.cpp on this machine", llamaCppAt("http://localhost:8080/v1"), NO_ENV, Deployment.Local, true],
    ["llama.cpp on another machine", llamaCppAt("http://192.168.1.20:8080/v1"), NO_ENV, Deployment.Local, false],
    [
      "an OpenAI-compatible server on the LAN",
      runConfig(Harness.OpenAI, { baseUrl: "http://192.168.1.20:8080/v1" }),
      NO_ENV,
      Deployment.Local,
      false,
    ],
    [
      "OPENAI_BASE_URL on this machine, as the OpenAI client reads it",
      runConfig(Harness.OpenAI),
      { OPENAI_BASE_URL: "http://localhost:1234/v1" },
      Deployment.Local,
      false,
    ],
    [
      "OPENAI_BASE_URL at a hosted API",
      runConfig(Harness.OpenAI),
      { OPENAI_BASE_URL: "https://api.together.xyz/v1" },
      Deployment.Hosted,
      false,
    ],
  ])("records %s, reading this machine only when it serves the model", (_, config, env, deployment, onThisMachine) => {
    expect(servingTarget(config, env)).toMatchObject({ deployment, onThisMachine });
  });
});

describe("runSubject", () => {
  const discovered: DiscoveredModel = {
    id: "acme/model",
    name: "Acme Model",
    quantization: "Q8_0",
    contextWindow: 8192,
    pricing: { promptUsdPerToken: 9e-6, completionUsdPerToken: 9e-6 },
    weightsHash: "b".repeat(64),
  };
  const pinned: ServingEndpoint = {
    tag: "deepinfra/fp8",
    tier: ServiceTier.Default,
    providerName: "DeepInfra",
    precision: "fp8",
    contextWindow: 131072,
    pricing: PRICING,
    supportsTools: true,
    healthy: true,
  };

  it("records the pinned endpoint over the run's flags, and the flags over what the provider reports", () => {
    const flagged = runConfig(Harness.OpenRouter, {}, { quantization: "Q4_K_M", contextWindow: 4096 });

    expect(runSubject(flagged, { discovered, pinned, local: null })).toMatchObject({
      model: { name: "Acme Model" },
      config: {
        quantization: "fp8",
        contextWindow: 131072,
        providerParameters: { provider: { order: ["deepinfra/fp8"], allow_fallbacks: false } },
      },
      modelHash: null,
      cost: PRICING,
    });
    expect(runSubject(flagged, { discovered, pinned: null, local: null }).config).toMatchObject({
      quantization: "Q4_K_M",
      contextWindow: 4096,
    });
  });

  it("bills a local run on GPU time and pins the weights the provider reports", () => {
    const local = runSubject(llamaCppAt("http://localhost:8080/v1"), {
      discovered,
      pinned: null,
      local: { gpuHourlyUsd: 0.5, modelHash: null },
    });

    expect(local).toMatchObject({ cost: { gpuHourlyUsd: 0.5 }, modelHash: discovered.weightsHash });
  });
});
