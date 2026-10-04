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
  it("reports when only non-default endpoints exist without opting into them", async () => {
    const endpoints = await served(raw("openai/fast", "bf16", "0.000004", "0.000016"));
    expect(() => pickEndpoint(endpoints)).toThrow(
      'no endpoint supports service tier "default". Available: openai/fast',
    );
  });

  it("rejects an exact tier endpoint that conflicts with the requested default tier", async () => {
    const endpoints = await served(raw("openai/flex", "bf16", "0.000001", "0.000004"));
    expect(() => pickEndpoint(endpoints, "openai/flex", "default")).toThrow(
      /no endpoint matches.*service tier "default"/,
    );
  });

  it.each([
    ["openai/fast", "openai/priority"],
    ["openai/priority", "openai/fast"],
  ])("matches the priority endpoint alias %s to %s", async (requested, tag) => {
    const endpoints = await served(raw(tag, "bf16", "0.000004", "0.000016"));
    expect(pickEndpoint(endpoints, requested, "priority").tag).toBe(tag);
  });

  it.each([
    ["priority", ["openai", "openai/flex", "openai/ultrafast"], "openai"],
    ["fast", ["openai", "openai/flex"], "openai"],
    ["ultrafast", ["openai", "openai/priority", "openai/flex"], "openai/priority"],
    ["ultrafast", ["openai", "openai/flex"], "openai"],
  ])("uses the next available tier for %s among %j", async (tier, tags, expected) => {
    const endpoints = await served(...tags.map((tag) => raw(tag, "bf16", "0.000002", "0.000008")));
    expect(pickEndpoint(endpoints, undefined, tier).tag).toBe(expected);
  });

  it("keeps a provider restriction when its priority tier is unavailable", async () => {
    const endpoints = await served(
      raw("openai", "bf16", "0.000002", "0.000008"),
      raw("google-vertex/priority", "bf16", "0.000004", "0.000016"),
    );
    expect(pickEndpoint(endpoints, "openai", "priority").tag).toBe("openai");
  });

  it.each([
    ["default", "openai"],
    ["flex", "openai/flex"],
    ["priority", "openai/fast"],
    ["fast", "openai/fast"],
    ["ultrafast", "openai/ultrafast"],
  ])("pins %s capacity before considering precision or price", async (tier, tag) => {
    const endpoints = await served(
      raw("openai", "bf16", "0.000002", "0.000008"),
      raw("openai/flex", "unknown", "0.000001", "0.000004"),
      raw("openai/fast", "unknown", "0.000004", "0.000016"),
      raw("openai/ultrafast", "fp32", "0.000008", "0.000032"),
    );
    expect(pickEndpoint(endpoints, undefined, tier).tag).toBe(tag);
  });

  it("pins a flex endpoint when flex is requested, even when standard has higher precision", async () => {
    const endpoints = await served(
      raw("openai", "bf16", "0.000002", "0.000008"),
      raw("google-vertex/flex", "unknown", "0.000001", "0.000004"),
    );
    expect(pickEndpoint(endpoints, undefined, "flex").tag).toBe("google-vertex/flex");
  });

  it.each([undefined, "default"])("does not opt into flex when service_tier is %s", async (tier) => {
    const endpoints = await served(
      raw("openai", "unknown", "0.000002", "0.000008"),
      raw("openai/flex", "unknown", "0.000001", "0.000004"),
    );
    expect(pickEndpoint(endpoints, undefined, tier).tag).toBe("openai");
  });

  it("honors a provider restriction within the flex endpoints", async () => {
    const endpoints = await served(
      raw("openai", "bf16", "0.000002", "0.000008"),
      raw("openai/flex", "unknown", "0.000001", "0.000004"),
      raw("google-vertex/flex", "bf16", "0.0000005", "0.000002"),
    );
    expect(pickEndpoint(endpoints, "OpenAI", "flex").tag).toBe("openai/flex");
    expect(pickEndpoint(endpoints, "openai/flex", "flex").tag).toBe("openai/flex");
  });

  it("rejects a standard-only provider restriction when flex endpoints exist", async () => {
    const endpoints = await served(
      raw("openai", "bf16", "0.000002", "0.000008"),
      raw("google-vertex/flex", "unknown", "0.000001", "0.000004"),
    );
    expect(() => pickEndpoint(endpoints, "openai", "flex")).toThrow(/no endpoint matches.*openai.*google-vertex\/flex/);
  });

  it("uses standard capacity when the model has no flex endpoints, matching OpenRouter", async () => {
    const endpoints = await served(raw("openai", "bf16", "0.000002", "0.000008"));
    expect(pickEndpoint(endpoints, undefined, "flex").tag).toBe("openai");
  });

  it("allows an explicit flex endpoint without a service_tier parameter", async () => {
    const endpoints = await served(
      raw("openai", "bf16", "0.000002", "0.000008"),
      raw("openai/flex", "unknown", "0.000001", "0.000004"),
    );
    expect(pickEndpoint(endpoints, "openai/flex").tag).toBe("openai/flex");
  });

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
