import { dirname, resolve } from "node:path";
import { selectCases, type SelectedCase } from "../engine/case-selection";
import { shellQuote } from "../engine/format";
import { errorMessage, isRecord } from "../engine/guards";
import { Harness, knownHarness } from "../engine/harness";
import { RunConfigSchema, type RunConfig } from "../engine/runconfig";
import { CaseSubset } from "../engine/subset";
import type { Suite } from "../engine/suite";
import {
  booleanFlag,
  fail,
  flagList,
  numberFlag,
  parseInput,
  readJsonFile,
  requireFlag,
  stringFlag,
  unknownFlags,
  type Flags,
} from "./args";
import { PROVIDER_NAMES, providerPreset } from "./providers";

enum RunFlag {
  Config = "config",
  Provider = "provider",
  Model = "model",
  Suite = "suite",
  Name = "name",
  Quant = "quant",
  Ctx = "ctx",
  Temp = "temp",
  Params = "params",
  ParamsFile = "params-file",
  NativeJson = "native-json",
  Subset = "subset",
  Category = "category",
  Fresh = "fresh",
  Out = "out",
  Endpoint = "endpoint",
}

const RUN_FLAGS_SOURCE = "run flags";
const REPRODUCED_SWITCHES: readonly string[] = [RunFlag.NativeJson];
const CONFIG_RUN_FLAGS = [RunFlag.Config, RunFlag.Model, RunFlag.Name, RunFlag.Subset];
const PROVIDER_RUN_FLAGS = [
  RunFlag.Provider,
  RunFlag.Model,
  RunFlag.Suite,
  RunFlag.Name,
  RunFlag.Quant,
  RunFlag.Ctx,
  RunFlag.Temp,
  RunFlag.Params,
  RunFlag.ParamsFile,
  RunFlag.NativeJson,
  RunFlag.Subset,
];
const SCOPE_FLAGS = [RunFlag.Category, RunFlag.Fresh, RunFlag.Out, RunFlag.Endpoint];

export const RUN_FLAGS: readonly string[] = Object.values(RunFlag);

export interface RunInputs {
  config: RunConfig;
  configDir: string;
  suitePath: string;
  reproduceCommand: string;
  categories: string[] | undefined;
  subset: CaseSubset | null;
  fresh: boolean;
  outPath: string | undefined;
  endpoint: string | undefined;
}

type ResolvedConfig = Pick<RunInputs, "config" | "configDir" | "suitePath" | "reproduceCommand">;

interface RecordedScope {
  pinnedTag: string | null;
  categories: readonly string[] | undefined;
  declaredCount: number;
}

export function resolveRunInputs(flags: Flags, command: string): RunInputs {
  const resolved = RunFlag.Config in flags ? configRun(flags, command) : providerRun(flags, command);
  const onOpenRouter = isOpenRouterRun(resolved.config);
  const endpoint = stringFlag(flags, RunFlag.Endpoint);
  if (endpoint && !onOpenRouter)
    fail(`--${RunFlag.Endpoint} pins an OpenRouter endpoint, so it needs --${RunFlag.Provider} openrouter.`);
  const categories = requestedCategories(flags);
  const subset = requestedSubset(flags);
  if (subset && categories)
    fail(`--${RunFlag.Subset} runs the whole suite, so it can't be combined with --${RunFlag.Category}.`);
  return {
    ...resolved,
    categories,
    subset,
    fresh: booleanFlag(flags, RunFlag.Fresh),
    outPath: stringFlag(flags, RunFlag.Out),
    endpoint,
  };
}

export function isOpenRouterRun(config: RunConfig): boolean {
  return knownHarness(config.openai.harness) === Harness.OpenRouter;
}

/** The cases the flags pick: the chosen tasks, or the whole suite. A subset run takes the whole suite. */
export function requestedCases(suite: Suite, { categories }: Pick<RunInputs, "categories">): SelectedCase[] {
  try {
    return selectCases(suite, categories);
  } catch (err) {
    fail(`--${RunFlag.Category}: ${errorMessage(err)}`);
  }
}

/** A rerun that runs no case leaves a complete run as it was, so it keeps the date it was measured. */
export function completesRun(completedAt: string | null, casesToRun: number): boolean {
  return casesToRun > 0 || completedAt === null;
}

/** The command recorded with a run: the one typed, pinned to the endpoint that served it, scoped to its tasks. */
export function recordedCommand(command: string, { pinnedTag, categories, declaredCount }: RecordedScope): string {
  const pinned = pinnedTag ? `${command} --${RunFlag.Endpoint} ${shellQuote(pinnedTag)}` : command;
  if (!categories || categories.length >= declaredCount) return pinned;
  return `${pinned} --${RunFlag.Category} ${shellQuote(categories.join(","))}`;
}

function configRun(flags: Flags, command: string): ResolvedConfig {
  const ignored = unknownFlags(flags, [...CONFIG_RUN_FLAGS, ...SCOPE_FLAGS]);
  if (ignored.length > 0) {
    fail(
      `${flagList(ignored)} cannot be combined with --${RunFlag.Config}. Set ${ignored.length === 1 ? "it" : "them"} in the config file instead.`,
    );
  }
  const path = requireFlag(flags, RunFlag.Config);
  const configDir = dirname(resolve(path));
  const parsed = parseInput(RunConfigSchema, readJsonFile(path), path);
  const modelId = stringFlag(flags, RunFlag.Model);
  const name =
    stringFlag(flags, RunFlag.Name) ?? (modelId && modelId !== parsed.model.id ? modelId : parsed.model.name);
  const config = { ...parsed, model: { ...parsed.model, id: modelId ?? parsed.model.id, name } };
  return {
    config,
    configDir,
    suitePath: resolve(configDir, config.suite),
    reproduceCommand: reproduceCommand(command, flags, CONFIG_RUN_FLAGS, modelId),
  };
}

function providerRun(flags: Flags, command: string): ResolvedConfig {
  const providerName = requireFlag(flags, RunFlag.Provider);
  const preset = providerPreset(providerName);
  if (!preset) fail(`unknown --${RunFlag.Provider} "${providerName}". One of: ${PROVIDER_NAMES.join(", ")}`);
  const suite = requireFlag(flags, RunFlag.Suite);
  const modelId = requireFlag(flags, RunFlag.Model);

  const config = parseInput(
    RunConfigSchema,
    {
      ...preset,
      suite,
      model: { id: modelId, name: stringFlag(flags, RunFlag.Name) ?? modelId, provider: providerName },
      config: {
        quantization: stringFlag(flags, RunFlag.Quant) ?? null,
        contextWindow: numberFlag(flags, RunFlag.Ctx) ?? null,
        temperature: numberFlag(flags, RunFlag.Temp) ?? 0,
        mtp: null,
        nativeJsonSchema: booleanFlag(flags, RunFlag.NativeJson),
        providerParameters: providerParameters(flags),
      },
    },
    RUN_FLAGS_SOURCE,
  );

  return {
    config,
    configDir: process.cwd(),
    suitePath: resolve(suite),
    reproduceCommand: reproduceCommand(command, flags, PROVIDER_RUN_FLAGS, modelId),
  };
}

function reproduceCommand(
  command: string,
  flags: Flags,
  reproduced: readonly RunFlag[],
  modelId: string | undefined,
): string {
  const args = ["run"];
  for (const name of reproduced) {
    if (REPRODUCED_SWITCHES.includes(name)) {
      if (booleanFlag(flags, name)) args.push(`--${name}`);
      continue;
    }
    const value = name === RunFlag.Model ? modelId : stringFlag(flags, name);
    if (value) args.push(`--${name}`, value);
  }
  return `${command} ${args.map(shellQuote).join(" ")}`;
}

function requestedSubset(flags: Flags): CaseSubset | null {
  const requested = stringFlag(flags, RunFlag.Subset);
  if (requested === undefined) return null;
  const subset = Object.values(CaseSubset).find((known) => known === requested);
  if (!subset) fail(`unknown --${RunFlag.Subset} "${requested}". One of: ${Object.values(CaseSubset).join(", ")}`);
  return subset;
}

function requestedCategories(flags: Flags): string[] | undefined {
  const requested = (stringFlag(flags, RunFlag.Category) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return requested.length > 0 ? [...new Set(requested)] : undefined;
}

function providerParameters(flags: Flags): Record<string, unknown> {
  const file = stringFlag(flags, RunFlag.ParamsFile);
  const inline = stringFlag(flags, RunFlag.Params);
  return {
    ...(file ? jsonObject(readJsonFile(file), `--${RunFlag.ParamsFile} ${file}`) : {}),
    ...(inline ? parseJsonObject(inline, `--${RunFlag.Params}`) : {}),
  };
}

function parseJsonObject(input: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    fail(`invalid JSON in ${source}: ${errorMessage(err)}`);
  }
  return jsonObject(parsed, source);
}

function jsonObject(value: unknown, source: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${source} must contain a JSON object`);
  return value;
}
