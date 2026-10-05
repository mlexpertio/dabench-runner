import { quantBits, type ApiPricing } from "./calc";
import { errorMessage, isJsonObject, isRecord, type JsonValue } from "./guards";
import { endpointRoots, fetchJson, parsePricing, type ProviderEndpoint } from "./provider-http";

export enum ServiceTier {
  Default = "default",
  Flex = "flex",
  Priority = "priority",
  Fast = "fast",
  Ultrafast = "ultrafast",
}

type ServedTier = Exclude<ServiceTier, ServiceTier.Fast>;

export interface ServingEndpoint {
  tag: string;
  tier: ServedTier;
  providerName: string;
  precision: string | null;
  contextWindow: number | null;
  pricing: ApiPricing | null;
  supportsTools: boolean;
  healthy: boolean;
}

const UNDISCLOSED_PRECISION = "unknown";
const TOOLS_PARAMETER = "tools";
const HEALTHY_STATUS = 0;
const UNKNOWN_PRECISION_BITS = 0;
const TAG_SEPARATOR = "/";
const TIER_PREFERENCE: Record<ServedTier, readonly ServedTier[]> = {
  [ServiceTier.Default]: [ServiceTier.Default],
  [ServiceTier.Flex]: [ServiceTier.Flex, ServiceTier.Default],
  [ServiceTier.Priority]: [ServiceTier.Priority, ServiceTier.Default],
  [ServiceTier.Ultrafast]: [ServiceTier.Ultrafast, ServiceTier.Priority, ServiceTier.Default],
};

export function parseServiceTier(value: unknown = ServiceTier.Default): ServiceTier {
  const tier = Object.values(ServiceTier).find((known) => known === value);
  if (!tier)
    throw new Error(`unknown service tier ${JSON.stringify(value)}. One of: ${Object.values(ServiceTier).join(", ")}`);
  return tier;
}

export async function fetchEndpoints(endpoint: ProviderEndpoint & { modelId: string }): Promise<ServingEndpoint[]> {
  const url = `${endpointRoots(endpoint.baseUrl).v1}/models/${endpoint.modelId}/endpoints`;
  try {
    return parseEndpoints(await fetchJson(url, endpoint));
  } catch (err) {
    throw new Error(`endpoint list ${url}: ${errorMessage(err)}`);
  }
}

function parseEndpoints(payload: unknown): ServingEndpoint[] {
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : {};
  const endpoints = Array.isArray(data.endpoints) ? data.endpoints.filter(isRecord) : [];
  return endpoints.flatMap((raw) => {
    if (typeof raw.tag !== "string" || typeof raw.provider_name !== "string") return [];
    const precision = typeof raw.quantization === "string" ? raw.quantization : UNDISCLOSED_PRECISION;
    const parameters = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];
    return [
      {
        tag: raw.tag,
        tier: tagTier(raw.tag) ?? ServiceTier.Default,
        providerName: raw.provider_name,
        precision: precision === UNDISCLOSED_PRECISION ? null : precision,
        contextWindow: typeof raw.context_length === "number" ? raw.context_length : null,
        pricing: parsePricing(raw.pricing) ?? null,
        supportsTools: parameters.includes(TOOLS_PARAMETER),
        healthy: raw.status === HEALTHY_STATUS,
      },
    ];
  });
}

export function pickEndpoint(endpoints: ServingEndpoint[], tier: ServiceTier, requested?: string): ServingEndpoint {
  if (endpoints.length === 0) throw new Error("OpenRouter lists no endpoints for this model");
  const wanted = servedTier(tier);
  const tiers =
    wanted === ServiceTier.Flex && endpoints.some((endpoint) => endpoint.tier === ServiceTier.Flex)
      ? [ServiceTier.Flex]
      : TIER_PREFERENCE[wanted];
  const ranked = endpoints.filter((endpoint) => tiers.includes(endpoint.tier)).sort(byPreference);
  const asked = requested ? ranked.filter((endpoint) => matches(endpoint, requested)) : ranked;
  for (const preferred of tiers) {
    const group = asked.filter((endpoint) => endpoint.tier === preferred);
    const selected = group.find((endpoint) => endpoint.supportsTools) ?? group[0];
    if (selected) return selected;
  }
  const target = requested ? `matches "${requested}" for service tier "${tier}"` : `supports service tier "${tier}"`;
  throw new Error(`no endpoint ${target}. Available: ${endpoints.map((endpoint) => endpoint.tag).join(", ")}`);
}

function servedTier(tier: ServiceTier): ServedTier {
  return tier === ServiceTier.Fast ? ServiceTier.Priority : tier;
}

function tagTier(tag: string): ServedTier | null {
  const tier = Object.values(ServiceTier).find((known) => tag.toLowerCase().endsWith(`${TAG_SEPARATOR}${known}`));
  return tier ? servedTier(tier) : null;
}

export function pinnedParameters(
  parameters: Record<string, JsonValue>,
  endpoint: ServingEndpoint,
): Record<string, JsonValue> {
  const routing = isJsonObject(parameters.provider) ? parameters.provider : {};
  return { ...parameters, provider: { ...routing, order: [endpoint.tag], allow_fallbacks: false } };
}

export function pinnedTag(parameters: Record<string, JsonValue>): string | null {
  const routing = parameters.provider;
  if (!isRecord(routing) || routing.allow_fallbacks !== false || !Array.isArray(routing.order)) return null;
  const [tag] = routing.order;
  return typeof tag === "string" ? tag : null;
}

function byPreference(a: ServingEndpoint, b: ServingEndpoint): number {
  return (
    precisionBits(b) - precisionBits(a) ||
    Number(b.healthy) - Number(a.healthy) ||
    price(a) - price(b) ||
    a.tag.localeCompare(b.tag)
  );
}

function precisionBits(endpoint: ServingEndpoint): number {
  return quantBits(endpoint.precision) ?? UNKNOWN_PRECISION_BITS;
}

function price(endpoint: ServingEndpoint): number {
  return endpoint.pricing ? endpoint.pricing.promptUsdPerToken + endpoint.pricing.completionUsdPerToken : Infinity;
}

function matches(endpoint: ServingEndpoint, requested: string): boolean {
  const wanted = normalizedTag(requested);
  const tag = normalizedTag(endpoint.tag);
  const provider = tag.split(TAG_SEPARATOR)[0];
  return [tag, provider, endpoint.providerName.toLowerCase()].includes(wanted);
}

function normalizedTag(tag: string): string {
  const lower = tag.toLowerCase();
  const tier = tagTier(lower);
  return tier ? `${lower.slice(0, lower.lastIndexOf(TAG_SEPARATOR))}${TAG_SEPARATOR}${tier}` : lower;
}
