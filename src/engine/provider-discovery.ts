import type { ApiPricing } from "./calc";
import { errorMessage, isJsonObject, isRecord, type JsonObject, type JsonValue } from "./guards";
import { Harness, knownHarness } from "./harness";
import { endpointRoots, fetchJson, parsePricing, type ProviderEndpoint } from "./provider-http";
import { Sha256HexSchema } from "./schema";

const MAX_METADATA_ARRAY_LENGTH = 48;
const MAX_NESTED_SEARCH_DEPTH = 8;
const TRAILING_SLASHES = /\/+$/;

export interface DiscoveredModel {
  id: string;
  name: string;
  quantization?: string;
  contextWindow?: number;
  maxCompletionTokens?: number;
  pricing?: ApiPricing;
  weightsHash?: string;
  metadata: Record<string, JsonValue>;
}

interface ProviderDiscovery {
  models: DiscoveredModel[];
  warnings: string[];
}

type Entry = JsonObject;
type IdentifiedEntry = Entry & { id: string };

const DISCOVERERS = {
  [Harness.Ollama]: discoverOllama,
  [Harness.LlamaCpp]: discoverLlamaCpp,
  [Harness.Vllm]: discoverVllm,
  [Harness.OpenRouter]: discoverOpenRouter,
} satisfies Partial<Record<Harness, (endpoint: ProviderEndpoint) => Promise<ProviderDiscovery>>>;

type DiscoverableHarness = keyof typeof DISCOVERERS;

function supportsDiscovery(harness: Harness): harness is DiscoverableHarness {
  return harness in DISCOVERERS;
}

export function discoverProviderModels(
  request: ProviderEndpoint & { harness: DiscoverableHarness },
): Promise<ProviderDiscovery>;
export function discoverProviderModels(
  request: ProviderEndpoint & { harness: string },
): Promise<ProviderDiscovery> | null;
export function discoverProviderModels({
  harness,
  ...endpoint
}: ProviderEndpoint & { harness: string }): Promise<ProviderDiscovery> | null {
  const known = knownHarness(harness);
  return known && supportsDiscovery(known) ? DISCOVERERS[known](endpoint) : null;
}

/** The models on a bare OpenAI-style /models list, read for ids, context and price only, so each name is left blank. */
export async function listModels(endpoint: ProviderEndpoint): Promise<DiscoveredModel[]> {
  const url = `${endpoint.baseUrl.replace(TRAILING_SLASHES, "")}/models`;
  return dataList(await requiredJson(url, endpoint)).map((raw) => ({
    id: raw.id,
    name: "",
    contextWindow: positiveNumber(raw.context_length),
    pricing: parsePricing(raw.pricing),
    metadata: {},
  }));
}

async function discoverOpenRouter(endpoint: ProviderEndpoint): Promise<ProviderDiscovery> {
  const { v1 } = endpointRoots(endpoint.baseUrl);
  const entries = dataList(await requiredJson(`${v1}/models?output_modalities=all`, endpoint));
  const models = entries.map(
    (raw) =>
      ({
        id: raw.id,
        name: textValue(raw.name) ?? raw.id,
        contextWindow: positiveNumber(raw.context_length),
        maxCompletionTokens: positiveNumber(recordValue(raw.top_provider)?.max_completion_tokens),
        pricing: parsePricing(raw.pricing),
        metadata: { models: raw },
      }) satisfies DiscoveredModel,
  );
  const requested = endpoint.modelId;
  return { models: requested ? models.filter((model) => model.id === requested) : models, warnings: [] };
}

async function discoverOllama(endpoint: ProviderEndpoint): Promise<ProviderDiscovery> {
  const { root } = endpointRoots(endpoint.baseUrl);
  const warnings: string[] = [];
  const [tagsPayload, runningPayload] = await Promise.all([
    requiredJson(`${root}/api/tags`, endpoint),
    optionalJson(`${root}/api/ps`, endpoint, warnings),
  ]);
  const tags = objectList(recordValue(tagsPayload)?.models);
  const running = objectList(recordValue(runningPayload)?.models);
  const requested = endpoint.modelId;
  const selected = requested
    ? selectRequested(tags, requested, { name: requested, model: requested })
    : tags.filter(supportsCompletion);

  const models = await Promise.all(
    selected.flatMap((tag) => {
      const id = textValue(tag.model) ?? textValue(tag.name) ?? requested;
      return id ? [describeOllamaModel(tag, id, running, endpoint, warnings)] : [];
    }),
  );
  return { models, warnings };
}

async function describeOllamaModel(
  tag: Entry,
  id: string,
  running: Entry[],
  endpoint: ProviderEndpoint,
  warnings: string[],
): Promise<DiscoveredModel> {
  const { root } = endpointRoots(endpoint.baseUrl);
  const show = endpoint.modelId
    ? await optionalJson(`${root}/api/show`, endpoint, warnings, {
        method: "POST",
        body: JSON.stringify({ model: id, verbose: true }),
      })
    : undefined;
  const showRecord = recordValue(show);
  const modelInfo = recordValue(showRecord?.model_info);
  const details = recordValue(showRecord?.details) ?? recordValue(tag.details);
  const runningEntry = running.find((entry) => modelMatches(entry, id));
  return {
    id,
    name: textValue(modelInfo?.["general.name"]) ?? textValue(tag.name) ?? textValue(tag.model) ?? id,
    quantization: textValue(details?.quantization_level),
    contextWindow: modelInfoContext(modelInfo) ?? positiveNumber(recordValue(runningEntry)?.context_length),
    weightsHash: ollamaWeightsHash(tag.digest),
    metadata: sentRecords({
      tags: tag,
      show: show === undefined ? undefined : pruneLargeArrays(show),
      running: runningEntry,
    }),
  };
}

function ollamaWeightsHash(digest: unknown): string | undefined {
  if (typeof digest !== "string") return undefined;
  const hash = digest.replace(/^sha256:/, "").toLowerCase();
  return Sha256HexSchema.safeParse(hash).success ? hash : undefined;
}

function supportsCompletion(tag: Entry): boolean {
  const caps = tag.capabilities;
  if (!Array.isArray(caps)) return true;
  return caps.some((c) => c === "completion");
}

async function discoverLlamaCpp(endpoint: ProviderEndpoint): Promise<ProviderDiscovery> {
  const { root, v1 } = endpointRoots(endpoint.baseUrl);
  const warnings: string[] = [];
  const entries = dataList(await requiredJson(`${v1}/models`, endpoint));
  const requested = endpoint.modelId;
  const selected = requested ? selectRequested(entries, requested, { id: requested }) : entries;

  const models = await Promise.all(
    selected.map(async (raw): Promise<DiscoveredModel> => {
      const props = requested
        ? await optionalJson(`${root}/props?model=${encodeURIComponent(raw.id)}`, endpoint, warnings)
        : undefined;
      const propsRecord = recordValue(props);
      const defaults = recordValue(propsRecord?.default_generation_settings);
      const params = recordValue(defaults?.params);
      const modelPath = textValue(propsRecord?.model_path);
      return {
        id: raw.id,
        name: ggufModelName(raw.id),
        quantization: textValue(propsRecord?.quantization) ?? inferQuantization(modelPath) ?? inferQuantization(raw.id),
        contextWindow:
          positiveNumber(params?.n_ctx) ?? positiveNumber(defaults?.n_ctx) ?? positiveNumber(raw.context_length),
        metadata: sentRecords({ models: raw, props }),
      };
    }),
  );
  return { models, warnings };
}

async function discoverVllm(endpoint: ProviderEndpoint): Promise<ProviderDiscovery> {
  const { root, v1 } = endpointRoots(endpoint.baseUrl);
  const warnings: string[] = [];
  const [payload, serverInfo, version] = await Promise.all([
    requiredJson(`${v1}/models`, endpoint),
    optionalJson(`${root}/server_info?config_format=json`, endpoint, warnings),
    optionalJson(`${root}/version`, endpoint, warnings),
  ]);
  const entries = dataList(payload);
  const requested = endpoint.modelId;
  const selected = requested ? selectRequested(entries, requested, { id: requested }) : entries;

  return {
    models: selected.map((raw) => {
      const rootModel = textValue(raw.root);
      return {
        id: raw.id,
        name: rootModel ?? raw.id,
        quantization:
          findNested(serverInfo, ["quantization", "quantization_method"], textValue) ??
          inferQuantization(rootModel) ??
          inferQuantization(raw.id),
        contextWindow:
          positiveNumber(raw.max_model_len) ??
          findNested(serverInfo, ["max_model_len", "max_seq_len", "max_position_embeddings"], positiveNumber),
        metadata: sentRecords({ models: raw, serverInfo, version }),
      } satisfies DiscoveredModel;
    }),
    warnings,
  };
}

function selectRequested<T extends Entry>(entries: T[], modelId: string, placeholder: NoInfer<T>): T[] {
  const matching = entries.filter((entry) => modelMatches(entry, modelId));
  return matching.length > 0 ? matching : [placeholder];
}

async function requiredJson(url: string, endpoint: ProviderEndpoint): Promise<JsonValue> {
  try {
    return await fetchJson(url, endpoint);
  } catch (err) {
    throw new Error(`model catalog ${url}: ${errorMessage(err)}`);
  }
}

function optionalJson(
  url: string,
  endpoint: ProviderEndpoint,
  warnings: string[],
  init?: RequestInit,
): Promise<JsonValue | undefined> {
  return fetchJson(url, endpoint, init).catch((err: unknown) => {
    warnings.push(`optional metadata ${url}: ${errorMessage(err)}`);
    return undefined;
  });
}

function dataList(payload: JsonValue): IdentifiedEntry[] {
  return objectList(recordValue(payload)?.data).filter((entry): entry is IdentifiedEntry =>
    Boolean(textValue(entry.id)),
  );
}

function objectList(value: JsonValue | undefined): Entry[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function recordValue(value: JsonValue | undefined): Entry | undefined {
  return isJsonObject(value) ? value : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function modelMatches(entry: Entry, modelId: string): boolean {
  return [entry.id, entry.model, entry.name, entry.root].some((value) => value === modelId);
}

function modelInfoContext(info: Entry | undefined): number | undefined {
  if (!info) return undefined;
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith(".context_length")) {
      const context = positiveNumber(value);
      if (context) return context;
    }
  }
  return undefined;
}

function inferQuantization(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .match(/(?:^|[-_.:])((?:I?Q\d(?:_[A-Z0-9]+)+)|(?:BF|FP|INT)\d+|AWQ|GPTQ|NF4)(?:\.|$)/i)?.[1]
    ?.toUpperCase();
}

function ggufModelName(id: string): string {
  if (!/\.gguf$/i.test(id)) return id;
  const base = id.split(/[\\/]/).pop() ?? id;
  return base.replace(/(?:-\d{5}-of-\d{5})?\.gguf$/i, "");
}

function pruneLargeArrays(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.length > MAX_METADATA_ARRAY_LENGTH
      ? { elided: true, length: value.length }
      : value.map((item) => pruneLargeArrays(item));
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, pruneLargeArrays(entry)]));
  }
  return value;
}

/** The provider's records, leaving out the ones it didn't send. */
function sentRecords(records: Record<string, JsonValue | undefined>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(records).filter((record): record is [string, JsonValue] => record[1] !== undefined),
  );
}

function findNested<T>(
  value: unknown,
  keys: string[],
  accept: (candidate: unknown) => T | undefined,
  depth = 0,
): T | undefined {
  if (depth > MAX_NESTED_SEARCH_DEPTH) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNested(item, keys, accept, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const accepted = accept(value[key]);
    if (accepted !== undefined) return accepted;
  }
  for (const nested of Object.values(value)) {
    const found = findNested(nested, keys, accept, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}
