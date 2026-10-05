import { runKey, type RunIdentity } from "../src/engine/artifact";
import { Deployment, type ModelConfig, type ModelRef } from "../src/engine/schema";
import type { Suite } from "../src/engine/suite";

interface TestIdentityInput extends Partial<Omit<RunIdentity, "fingerprint" | "configHash">> {
  suite: Suite;
  model: ModelRef;
  config: ModelConfig;
}

export function testIdentity({
  suite,
  model,
  config,
  modelHash = null,
  subset = null,
  ...rest
}: TestIdentityInput): RunIdentity {
  return {
    ...runKey({ suite, model, config, modelHash, subset }),
    runId: "run-under-test",
    startedAt: new Date(0).toISOString(),
    hardware: null,
    deployment: Deployment.Local,
    servingProvider: null,
    reproduceCommand: "npm run engine -- run",
    ...rest,
  };
}
