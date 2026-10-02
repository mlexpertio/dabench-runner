import type { ApiPricing } from "./calc";
import { isRecord, type JsonValue } from "./guards";

export interface ProviderEndpoint {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  modelId?: string;
  fetchImpl?: typeof fetch;
}

export function endpointRoots(baseUrl: string): { root: string; v1: string } {
  const clean = baseUrl.replace(/\/+$/, "");
  if (/\/v1$/i.test(clean)) return { root: clean.slice(0, -3), v1: clean };
  return { root: clean, v1: `${clean}/v1` };
}

export async function fetchJson(url: string, endpoint: ProviderEndpoint, init?: RequestInit): Promise<JsonValue> {
  const fetchImpl = endpoint.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...endpoint.headers,
    ...(init?.body ? { "Content-Type": "application/json" } : {}),
  };
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;
  const response = await fetchImpl(url, { ...init, headers: { ...headers, ...init?.headers } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
  return response.json();
}

export function parsePricing(value: unknown): ApiPricing | undefined {
  if (!isRecord(value)) return undefined;
  const prompt = Number(value.prompt);
  const completion = Number(value.completion);
  return Number.isFinite(prompt) && Number.isFinite(completion)
    ? { promptUsdPerToken: prompt, completionUsdPerToken: completion }
    : undefined;
}
