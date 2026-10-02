import { describe, expect, it } from "vitest";
import { providerPreset } from "dabench/cli/providers";
import { Deployment, runDeployment } from "dabench/engine/deployment";
import { Harness } from "dabench/engine/harness";
import { RunConfigSchema, type RunConfig } from "dabench/engine/runconfig";

const NO_ENV = {};

function providerRun(name: Harness, baseUrl?: string): RunConfig {
  const preset = providerPreset(name);
  return RunConfigSchema.parse({
    ...preset,
    openai: { ...preset?.openai, ...(baseUrl ? { baseUrl } : {}) },
    suite: "suites/sample.suite.json",
    model: { id: "acme/model", name: "Model", provider: name },
    config: {},
  });
}

describe("runDeployment", () => {
  it.each([
    [Harness.OpenRouter, Deployment.Hosted],
    [Harness.LlamaCpp, Deployment.Local],
  ])("records a %s run as %s", (provider, deployment) => {
    expect(runDeployment(providerRun(provider), NO_ENV)).toBe(deployment);
  });

  it.each(["http://localhost:1234/v1", "http://192.168.1.20:8080/v1"])(
    "records an OpenAI-compatible server at %s as local",
    (baseUrl) => {
      expect(runDeployment(providerRun(Harness.OpenAI, baseUrl), NO_ENV)).toBe(Deployment.Local);
    },
  );

  it("follows OPENAI_BASE_URL when the run names no base URL, as the OpenAI client does", () => {
    const run = providerRun(Harness.OpenAI);
    expect(runDeployment(run, { OPENAI_BASE_URL: "http://localhost:1234/v1" })).toBe(Deployment.Local);
    expect(runDeployment(run, { OPENAI_BASE_URL: "https://api.together.xyz/v1" })).toBe(Deployment.Hosted);
  });
});
