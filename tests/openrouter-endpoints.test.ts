import { describe, expect, it } from "vitest";
import {
  fetchEndpoints,
  pickEndpoint,
  pinnedParameters,
  type ServingEndpoint,
} from "dabench/engine/openrouter-endpoints";

const TOOLS = ["max_tokens", "temperature", "tools", "tool_choice"];
const NO_TOOLS = ["max_tokens", "temperature"];
const HEALTHY = 0;
const DEGRADED = -2;

function raw(tag: string, quantization: string, prompt: string, completion: string, extra: object = {}) {
  return {
    name: `${tag} | acme/model`,
    provider_name: tag.split("/")[0].toUpperCase(),
    tag,
    quantization,
    context_length: 131072,
    pricing: { prompt, completion, discount: 0 },
    supported_parameters: TOOLS,
    status: HEALTHY,
    ...extra,
  };
}

const DEEPINFRA_FP8 = raw("deepinfra/fp8", "fp8", "0.00000014", "0.00000042");

function served(...endpoints: object[]): Promise<ServingEndpoint[]> {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ data: { id: "acme/model", endpoints } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  return fetchEndpoints({ baseUrl: "https://openrouter.ai/api/v1", modelId: "acme/model", fetchImpl });
}

describe("fetchEndpoints", () => {
  it("reads who serves the model, at what precision, context and price", async () => {
    const [endpoint] = await served(raw("deepinfra/fp8", "fp8", "0.00000014", "0.00000042"));
    expect(endpoint).toEqual({
      tag: "deepinfra/fp8",
      providerName: "DEEPINFRA",
      precision: "fp8",
      contextWindow: 131072,
      pricing: { promptUsdPerToken: 0.00000014, completionUsdPerToken: 0.00000042 },
      supportsTools: true,
      healthy: true,
    });
  });
});

describe("pickEndpoint", () => {
  it("pins the highest disclosed precision that can call tools, cheapest first", async () => {
    const endpoints = await served(
      raw("dekallm", "unknown", "0.00000004", "0.00000049"),
      raw("open-inference/fp4", "fp4", "0.0000001", "0.0000005"),
      raw("coreweave/fp8", "fp8", "0.0000002", "0.00000065"),
      raw("deepinfra/fp8", "fp8", "0.00000014", "0.00000042"),
      raw("lab/bf16", "bf16", "0.0000001", "0.0000003", { supported_parameters: NO_TOOLS }),
    );
    expect(pickEndpoint(endpoints).tag).toBe("deepinfra/fp8");
  });

  it("prefers a healthy endpoint over a degraded one at the same precision and price", async () => {
    const endpoints = await served(
      raw("deepinfra/fp8", "fp8", "0.00000014", "0.00000028", { status: DEGRADED }),
      raw("xiaomi/fp8", "fp8", "0.00000014", "0.00000028"),
    );
    expect(pickEndpoint(endpoints).tag).toBe("xiaomi/fp8");
  });

  it("records an undisclosed precision as unknown, and falls back to it when no endpoint discloses one", async () => {
    const endpoints = await served(raw("alibaba", "unknown", "0.0000003", "0.0000012"));
    expect(endpoints[0].precision).toBeNull();
    expect(pickEndpoint(endpoints).tag).toBe("alibaba");
  });

  it("pins the endpoint the operator asked for, by tag or by provider", async () => {
    const endpoints = await served(
      raw("deepinfra/fp8", "fp8", "0.00000014", "0.00000042"),
      raw("deepinfra/bf16", "bf16", "0.0000003", "0.0000009"),
      raw("baseten/fp8", "fp8", "0.0000003", "0.0000012"),
    );
    expect(pickEndpoint(endpoints, "baseten/fp8").tag).toBe("baseten/fp8");
    expect(pickEndpoint(endpoints, "DeepInfra").tag).toBe("deepinfra/bf16");
  });

  it.each([
    ["the asked-for one isn't served, naming those that are", [DEEPINFRA_FP8], "together", /together.*deepinfra\/fp8/],
    ["no provider serves the model", [], undefined, /no endpoints/],
  ])("refuses to pin when %s", async (_, raws, requested, message) => {
    const endpoints = await served(...raws);
    expect(() => pickEndpoint(endpoints, requested)).toThrow(message);
  });
});

describe("pinnedParameters", () => {
  it("pins the endpoint with fallbacks off and keeps the operator's other parameters", async () => {
    const [endpoint] = await served(DEEPINFRA_FP8);
    expect(pinnedParameters({ seed: 42, provider: { sort: "throughput" } }, endpoint)).toEqual({
      seed: 42,
      provider: { sort: "throughput", order: ["deepinfra/fp8"], allow_fallbacks: false },
    });
  });
});
