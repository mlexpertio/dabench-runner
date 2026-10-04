import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliError, parseArgs, unknownFlags } from "dabench/cli/args";
import { completesRun, recordedCommand, resolveRunInputs } from "dabench/cli/run-inputs";
import { CaseSubset } from "dabench/engine/subset";

const COMMAND = "npm run engine --";
const SUITE = "suites/sample.suite.json";
const LOCAL = ["--provider", "llama.cpp", "--model", "gemma", "--suite", SUITE];
const OPENROUTER = ["--provider", "openrouter", "--model", "acme/x", "--suite", SUITE];
const CONFIG = join(mkdtempSync(join(tmpdir(), "dabench-run-inputs-")), "run.json");
const ROUTER_CONFIG = join(mkdtempSync(join(tmpdir(), "dabench-router-inputs-")), "run.json");
const PARAMS_FILE = `${ROUTER_CONFIG}.params.json`;
writeFileSync(PARAMS_FILE, JSON.stringify({ service_tier: "flex", seed: 42 }));
writeFileSync(
  ROUTER_CONFIG,
  JSON.stringify({
    suite: SUITE,
    model: { id: "acme/x", name: "Acme", provider: "openrouter" },
    config: { providerParameters: { service_tier: "priority", seed: 42 } },
    openai: { harness: "openrouter" },
  }),
);
writeFileSync(
  CONFIG,
  JSON.stringify({
    suite: SUITE,
    model: { id: "gemma", name: "Gemma", provider: "google" },
    config: {},
    openai: { harness: "llama.cpp", local: {} },
  }),
);

function inputs(argv: string[]) {
  return resolveRunInputs(parseArgs(argv), COMMAND);
}

describe("run inputs", () => {
  it.each([
    [[...OPENROUTER, "--service-tier", "urgent"], "default, flex, priority, fast, ultrafast"],
    [[...OPENROUTER, "--service-tier"], "--service-tier needs a value"],
    [[...OPENROUTER, "--service-tier="], "missing required --service-tier"],
    [[...LOCAL, "--service-tier", "flex"], "--service-tier requires an OpenRouter run"],
    [["--config", CONFIG, "--service-tier", "flex"], "--service-tier requires an OpenRouter run"],
    [[...OPENROUTER, "--params", '{"service_tier":"urgent"}'], "default, flex, priority, fast, ultrafast"],
    [[...OPENROUTER, "--params", '{"service_tier":null}'], "default, flex, priority, fast, ultrafast"],
  ])("rejects invalid tier options %j", (argv, message) => {
    expect(() => inputs(argv)).toThrow(CliError);
    expect(() => inputs(argv)).toThrow(message);
  });

  it("defaults OpenRouter runs to the default service tier without changing local runs", () => {
    expect(inputs(OPENROUTER).config.config.providerParameters).toEqual({ service_tier: "default" });
    expect(inputs(LOCAL).config.config.providerParameters).toEqual({});
  });

  it.each([
    [[...OPENROUTER, "--params", '{"service_tier":"priority","seed":42}'], "priority"],
    [[...OPENROUTER, "--params", '{"service_tier":"priority","seed":42}', "--service-tier", "default"], "default"],
    [["--config", ROUTER_CONFIG], "priority"],
    [["--config", ROUTER_CONFIG, "--service-tier", "flex"], "flex"],
    [[...OPENROUTER, "--params-file", PARAMS_FILE], "flex"],
    [[...OPENROUTER, "--params-file", PARAMS_FILE, "--service-tier", "ultrafast"], "ultrafast"],
  ])("resolves the tier from %j", (argv, tier) => {
    const run = inputs(argv);
    expect(run.config.config.providerParameters).toEqual({ service_tier: tier, seed: 42 });
    if (argv.includes("--service-tier")) expect(run.reproduceCommand).toContain(`--service-tier ${tier}`);
  });

  it.each(["default", "flex", "priority", "fast", "ultrafast"])(
    "sets and records the OpenRouter service tier %s",
    (tier) => {
      const run = inputs([...OPENROUTER, "--service-tier", tier]);
      expect(run.config.config.providerParameters.service_tier).toBe(tier);
      expect(run.reproduceCommand).toContain(`--service-tier ${tier}`);
    },
  );

  it.each([
    [`--config ${CONFIG} --quant Q8_0 --temp 1`, "--quant, --temp cannot be combined with --config"],
    [`${LOCAL.join(" ")} --temp abc`, "--temp must be a non-negative number"],
    [`${LOCAL.join(" ")} --temp`, "--temp must be a non-negative number"],
    [`${LOCAL.join(" ")} --category`, "--category needs a value"],
    [`${LOCAL.join(" ")} --fresh false`, "--fresh takes no value"],
    [`${LOCAL.join(" ")} --endpoint deepinfra/fp8`, "--endpoint pins an OpenRouter endpoint"],
    [`${LOCAL.join(" ")} --subset tiny`, "One of: quant-impact"],
    [`${LOCAL.join(" ")} --subset quant-impact --category coding`, "can't be combined with --category"],
  ])("rejects %s", (argv, message) => {
    expect(() => inputs(argv.split(" "))).toThrow(message);
  });

  it("reports a value the run config rejects as a CLI error, not a stack trace", () => {
    const zeroContext = () => inputs([...LOCAL, "--ctx", "0"]);

    expect(zeroContext).toThrow(CliError);
    expect(zeroContext).toThrow("config.contextWindow");
  });

  it("reports a missing params file as a CLI error, not a stack trace", () => {
    const missingFile = () => inputs([...LOCAL, "--params-file", "missing-params.json"]);

    expect(missingFile).toThrow(CliError);
    expect(missingFile).toThrow("missing-params.json");
  });

  it("records a command that reproduces the run", () => {
    expect(inputs([...LOCAL, "--name", "My Model", "--temp", "0.5", "--native-json"]).reproduceCommand).toBe(
      `${COMMAND} run --provider llama.cpp --model gemma --suite ${SUITE} --name 'My Model' --temp 0.5 --native-json`,
    );
    expect(inputs(["--config", CONFIG, "--name", "Gemma"]).reproduceCommand).toBe(
      `${COMMAND} run --config ${CONFIG} --name Gemma`,
    );
  });

  it("records the endpoint the run was pinned to, not the one asked for", () => {
    const run = inputs(["--provider", "openrouter", "--model", "acme/x", "--suite", SUITE, "--endpoint", "deepinfra"]);
    expect(run.endpoint).toBe("deepinfra");
    expect(run.reproduceCommand).not.toContain("--endpoint");
    expect(
      recordedCommand(run.reproduceCommand, { pinnedTag: "deepinfra/fp8", categories: undefined, declaredCount: 1 }),
    ).toBe(`${COMMAND} run --provider openrouter --model acme/x --suite ${SUITE} --endpoint deepinfra/fp8`);
  });

  it("labels a run with a named subset and records it in the command", () => {
    const run = inputs([...LOCAL, "--subset", "quant-impact"]);
    expect(run.subset).toBe(CaseSubset.QuantImpact);
    expect(run.reproduceCommand).toBe(
      `${COMMAND} run --provider llama.cpp --model gemma --suite ${SUITE} --subset quant-impact`,
    );
  });
});

describe("unknownFlags", () => {
  it("names every flag the command does not take, so a removed or mistyped flag never runs silently", () => {
    const flags = parseArgs(["--categories", "coding", "--model", "x", "--fresh", "--max-tokens=10"]);
    expect(unknownFlags(flags, ["model", "fresh", "category"])).toEqual(["categories", "max-tokens"]);
  });
});

describe("completesRun", () => {
  const COMPLETED_AT = "2026-09-01T10:00:00.000Z";

  it("leaves a complete run's date alone when a rerun runs no case", () => {
    expect(completesRun(COMPLETED_AT, 0)).toBe(false);
    expect(completesRun(COMPLETED_AT, 3)).toBe(true);
    expect(completesRun(null, 0)).toBe(true);
  });
});
