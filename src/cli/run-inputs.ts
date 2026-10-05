import { dirname, resolve } from "node:path";
import { selectCases, type SelectedCase } from "../engine/case-selection";
import { shellQuote } from "../engine/format";
import { errorMessage, isRecord } from "../engine/guards";
import {
  DEFAULT_BASE_URLS,
  Harness,
  isLocalHarness,
  knownHarness,
  OPENROUTER_API_KEY_ENV,
  OPENROUTER_ATTRIBUTION_HEADERS,
} from "../engine/harness";
import { parseServiceTier, type ServiceTier } from "../engine/openrouter-endpoints";
import { CaseSubset } from "../engine/schema";
import type { Suite } from "../engine/suite";
import {
  booleanFlag,
  enumFlag,
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
import { RunConfigSchema, type RunConfig, type RunConfigInput } from "./run-config";

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
  Subset = "subset",
  Category = "category",
  Out = "out",
  Endpoint = "endpoint",
  ServiceTier = "service-tier",
  Fresh = "fresh",
}

const RUN_FLAGS_SOURCE = "run flags";
const CONFIG_RUN_FLAGS: readonly string[] = [
  RunFlag.Config,
  RunFlag.Model,
  RunFlag.Name,
  RunFlag.Subset,
  RunFlag.ServiceTier,
];
const SCOPE_FLAGS: readonly string[] = [RunFlag.Category, RunFlag.Fresh, RunFlag.Out, RunFlag.Endpoint];
const PUBLIC_RUN_FLAGS = Object.values(RunFlag).filter((flag) => flag !== RunFlag.Fresh);
const BASE_URLS: Partial<Record<Harness, string>> = DEFAULT_BASE_URLS;

export function runFlags(resumable: boolean): readonly string[] {
  return resumable ? Object.values(RunFlag) : PUBLIC_RUN_FLAGS;
}

export interface RunInputs {
  config: RunConfig;
  configDir: string;
  suitePath: string;
  reproduceCommand: string;
  categories: string[] | undefined;
  subset: CaseSubset | null;
  serviceTier: ServiceTier | null;
  fresh: boolean;
  outPath: string | undefined;
  endpoint: string | undefined;
}

type ResolvedConfig = Pick<RunInputs, "config" | "configDir" | "suitePath">;

interface RecordedScope {
  pinnedTag: string | null;
  categories: readonly string[] | undefined;
  declaredCount: number;
}

export function resolveRunInputs(flags: Flags, command: string): RunInputs {
  const resolved = RunFlag.Config in flags ? configRun(flags) : providerRun(flags);
  const onOpenRouter = knownHarness(resolved.config.openai.harness) === Harness.OpenRouter;
  const requestedTier = RunFlag.ServiceTier in flags ? requireFlag(flags, RunFlag.ServiceTier) : undefined;
  if (requestedTier !== undefined && !onOpenRouter) fail(`--${RunFlag.ServiceTier} requires an OpenRouter run.`);
  const serviceTier = onOpenRouter ? openRouterTier(resolved.config, requestedTier) : null;
  const endpoint = stringFlag(flags, RunFlag.Endpoint);
  if (endpoint && !onOpenRouter)
    fail(`--${RunFlag.Endpoint} pins an OpenRouter endpoint, so it needs --${RunFlag.Provider} openrouter.`);
  const categories = requestedCategories(flags);
  const subset = enumFlag(flags, RunFlag.Subset, CaseSubset) ?? null;
  if (subset && categories)
    fail(`--${RunFlag.Subset} runs the whole suite, so it can't be combined with --${RunFlag.Category}.`);
  return {
    ...resolved,
    reproduceCommand: reproduceCommand(command, flags),
    categories,
    subset,
    serviceTier,
    fresh: booleanFlag(flags, RunFlag.Fresh),
    outPath: stringFlag(flags, RunFlag.Out),
    endpoint,
  };
}

export function requestedCases(suite: Suite, { categories }: Pick<RunInputs, "categories">): SelectedCase[] {
  try {
    return selectCases(suite, categories);
  } catch (err) {
    fail(`--${RunFlag.Category}: ${errorMessage(err)}`);
  }
}

export function recordedCommand(command: string, { pinnedTag, categories, declaredCount }: RecordedScope): string {
  const pinned = pinnedTag ? `${command} --${RunFlag.Endpoint} ${shellQuote(pinnedTag)}` : command;
  if (!categories || categories.length >= declaredCount) return pinned;
  return `${pinned} --${RunFlag.Category} ${shellQuote(categories.join(","))}`;
}

function openRouterTier(config: RunConfig, requested: string | undefined): ServiceTier {
  const parameters = config.config.providerParameters;
  try {
    const tier = parseServiceTier(requested ?? parameters.service_tier);
    parameters.service_tier = tier;
    return tier;
  } catch (err) {
    fail(`--${RunFlag.ServiceTier}: ${errorMessage(err)}`);
  }
}

function configRun(flags: Flags): ResolvedConfig {
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
  return { config, configDir, suitePath: resolve(configDir, config.suite) };
}

function providerRun(flags: Flags): ResolvedConfig {
  const harness = enumFlag(flags, RunFlag.Provider, Harness) ?? fail(`missing required --${RunFlag.Provider}`);
  const suite = requireFlag(flags, RunFlag.Suite);
  const modelId = requireFlag(flags, RunFlag.Model);

  const config = parseInput(
    RunConfigSchema,
    {
      openai: providerClient(harness),
      suite,
      model: { id: modelId, name: stringFlag(flags, RunFlag.Name) ?? modelId, provider: harness },
      config: {
        quantization: stringFlag(flags, RunFlag.Quant) ?? null,
        contextWindow: numberFlag(flags, RunFlag.Ctx) ?? null,
        temperature: numberFlag(flags, RunFlag.Temp) ?? 0,
        mtp: null,
        providerParameters: providerParameters(flags),
      },
    },
    RUN_FLAGS_SOURCE,
  );

  return { config, configDir: process.cwd(), suitePath: resolve(suite) };
}

function providerClient(harness: Harness): RunConfigInput["openai"] {
  return {
    harness,
    baseUrl: BASE_URLS[harness],
    ...(isLocalHarness(harness) ? { local: {} } : {}),
    ...(harness === Harness.OpenRouter
      ? { apiKeyEnv: OPENROUTER_API_KEY_ENV, headers: OPENROUTER_ATTRIBUTION_HEADERS }
      : {}),
  };
}

function reproduceCommand(command: string, flags: Flags): string {
  const args = ["run"];
  for (const [name, value] of Object.entries(flags)) {
    if (SCOPE_FLAGS.includes(name) || value === "") continue;
    args.push(`--${name}`, ...(typeof value === "string" ? [value] : []));
  }
  return `${command} ${args.map(shellQuote).join(" ")}`;
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
