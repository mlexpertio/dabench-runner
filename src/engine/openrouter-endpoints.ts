import { quantBits, type ApiPricing } from "./calc";
import { errorMessage, isJsonObject, isRecord, type JsonValue } from "./guards";
import { endpointRoots, fetchJson, parsePricing, type ProviderEndpoint } from "./provider-http";

export interface ServingEndpoint {
  tag: string;
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

/**
 * The endpoint a board run pins: the highest disclosed precision among those
 * that can call tools, healthy before degraded, cheapest first. An operator
 * can narrow the choice to one provider or one exact tag.
 */
export function pickEndpoint(endpoints: ServingEndpoint[], requested?: string): ServingEndpoint {
  if (endpoints.length === 0) throw new Error("OpenRouter lists no endpoints for this model");
  const ranked = [...endpoints].sort(byPreference);
  const asked = requested ? ranked.filter((e) => matches(e, requested)) : ranked;
  if (asked.length === 0) {
    throw new Error(`no endpoint matches "${requested}". Available: ${ranked.map((e) => e.tag).join(", ")}`);
  }
  return asked.find((e) => e.supportsTools) ?? asked[0];
}

export function pinnedParameters(
  parameters: Record<string, JsonValue>,
  endpoint: ServingEndpoint,
): Record<string, JsonValue> {
  const routing = isJsonObject(parameters.provider) ? parameters.provider : {};
  return { ...parameters, provider: { ...routing, order: [endpoint.tag], allow_fallbacks: false } };
}

/** The endpoint tag a run was pinned to, or null when OpenRouter was free to route it. */
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
  const wanted = requested.toLowerCase();
  const provider = endpoint.tag.split(TAG_SEPARATOR)[0];
  return [endpoint.tag, provider, endpoint.providerName.toLowerCase()].includes(wanted);
}
