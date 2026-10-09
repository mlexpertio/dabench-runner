import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliError, parseArgs, unknownFlags } from "../src/cli/args";
import { recordedCommand, resolveRunInputs, runFlags } from "../src/cli/run-inputs";

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
    [[...OPENROUTER, "--service-tier="], "missing required --service-tier"],
    [[...LOCAL, "--service-tier", "flex"], "--service-tier requires an OpenRouter run"],
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
    [[...OPENROUTER, "--params-file", PARAMS_FILE], "flex"],
  ])("resolves the tier from %j", (argv, tier) => {
    const run = inputs(argv);
    expect(run.config.config.providerParameters).toEqual({ service_tier: tier, seed: 42 });
    if (argv.includes("--service-tier")) expect(run.reproduceCommand).toContain(`--service-tier ${tier}`);
  });

  it.each([
    [`--config ${CONFIG} --quant Q8_0 --temp 1`, "--quant, --temp cannot be combined with --config"],
    [`${LOCAL.join(" ")} --temp abc`, "--temp must be a non-negative number"],
    [`${LOCAL.join(" ")} --temp`, "--temp must be a non-negative number"],
    [`${LOCAL.join(" ")} --fresh false`, "--fresh takes no value"],
    [`${LOCAL.join(" ")} --endpoint deepinfra/fp8`, "--endpoint pins an OpenRouter endpoint"],
    [`${LOCAL.join(" ")} --ctx 0`, "config.contextWindow"],
    [`${LOCAL.join(" ")} --params-file missing-params.json`, "missing-params.json"],
  ])("rejects %s as a CLI error, not a stack trace", (argv, message) => {
    expect(() => inputs(argv.split(" "))).toThrow(CliError);
    expect(() => inputs(argv.split(" "))).toThrow(message);
  });

  it("records a command that reproduces the run", () => {
    expect(inputs([...LOCAL, "--name", "My Model", "--temp", "0.5"]).reproduceCommand).toBe(
      `${COMMAND} run --provider llama.cpp --model gemma --suite ${SUITE} --name 'My Model' --temp 0.5`,
    );
    expect(inputs(["--config", CONFIG, "--name", "Gemma"]).reproduceCommand).toBe(
      `${COMMAND} run --config ${CONFIG} --name Gemma`,
    );
  });

  it("records the endpoint the run was pinned to, not the one asked for", () => {
    const run = inputs(["--provider", "openrouter", "--model", "acme/x", "--suite", SUITE, "--endpoint", "deepinfra"]);
    expect(run.endpoint).toBe("deepinfra");
    expect(run.reproduceCommand).not.toContain("--endpoint");
    expect(recordedCommand(run.reproduceCommand, "deepinfra/fp8")).toBe(
      `${COMMAND} run --provider openrouter --model acme/x --suite ${SUITE} --endpoint deepinfra/fp8`,
    );
  });
});

describe("unknownFlags", () => {
  it("names every flag the command does not take, so a removed or mistyped flag never runs silently", () => {
    const flags = parseArgs(["--categories", "coding", "--model", "x", "--fresh", "--max-tokens=10"]);
    expect(unknownFlags(flags, ["model", "fresh", "category"])).toEqual(["categories", "max-tokens"]);
  });

  it("takes --fresh only from a CLI that records runs it can resume", () => {
    const flags = parseArgs([...LOCAL, "--fresh"]);
    expect(unknownFlags(flags, runFlags(false))).toEqual(["fresh"]);
    expect(unknownFlags(flags, runFlags(true))).toEqual([]);
  });
});
