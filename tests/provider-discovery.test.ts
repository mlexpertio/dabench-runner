import { describe, expect, it } from "vitest";
import { Harness } from "dabench/engine/harness";
import { discoverProviderModels, listModels } from "dabench/engine/provider-discovery";

function endpointFetch(responses: Record<string, unknown>) {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const payload = responses[url];
    if (payload === undefined) return new Response("missing", { status: 404 });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl };
}

describe("provider-native model discovery", () => {
  it("fetches Ollama tags, running state, and verbose show metadata", async () => {
    const base = "http://localhost:11434";
    const { fetchImpl } = endpointFetch({
      [`${base}/api/tags`]: {
        models: [
          {
            name: "gemma3:4b",
            model: "gemma3:4b",
            digest: "sha256",
            details: { quantization_level: "Q4_K_M", parameter_size: "4.3B" },
          },
        ],
      },
      [`${base}/api/ps`]: { models: [{ name: "gemma3:4b", context_length: 8192 }] },
      [`${base}/api/show`]: {
        details: { quantization_level: "Q4_K_M" },
        capabilities: ["completion"],
        model_info: { "general.name": "Gemma 3 4B", "gemma3.context_length": 131072 },
      },
    });

    const result = await discoverProviderModels({
      harness: Harness.Ollama,
      baseUrl: `${base}/v1`,
      modelId: "gemma3:4b",
      fetchImpl,
    });

    expect(result.models[0]).toMatchObject({
      id: "gemma3:4b",
      name: "Gemma 3 4B",
      quantization: "Q4_K_M",
      contextWindow: 131072,
    });
    expect(result.models[0].metadata).toHaveProperty("show.capabilities", ["completion"]);
  });

  it("fetches llama.cpp /props and derives model name, context, and quantization", async () => {
    const base = "http://localhost:8080";
    const id = "Qwen3-4B-Q4_K_M.gguf";
    const { fetchImpl } = endpointFetch({
      [`${base}/v1/models`]: { data: [{ id, owned_by: "llamacpp" }] },
      [`${base}/props?model=${encodeURIComponent(id)}`]: {
        model_path: `/models/${id}`,
        default_generation_settings: { params: { n_ctx: 32768 } },
        chat_template: "template",
      },
    });
    const result = await discoverProviderModels({
      harness: Harness.LlamaCpp,
      baseUrl: `${base}/v1`,
      modelId: id,
      fetchImpl,
    });
    expect(result.models[0]).toMatchObject({
      id,
      name: "Qwen3-4B-Q4_K_M",
      quantization: "Q4_K_M",
      contextWindow: 32768,
    });
  });

  it("captures vLLM served identity, server config, and version", async () => {
    const base = "http://localhost:8000";
    const { fetchImpl } = endpointFetch({
      [`${base}/v1/models`]: {
        data: [{ id: "served-alias", root: "Qwen/Qwen3-8B-AWQ", max_model_len: 65536 }],
      },
      [`${base}/server_info?config_format=json`]: {
        vllm_config: { model_config: { quantization: "awq", max_model_len: 65536 } },
      },
      [`${base}/version`]: { version: "0.10.0" },
    });
    const result = await discoverProviderModels({
      harness: Harness.Vllm,
      baseUrl: `${base}/v1`,
      modelId: "served-alias",
      fetchImpl,
    });
    expect(result.models[0]).toMatchObject({
      id: "served-alias",
      name: "Qwen/Qwen3-8B-AWQ",
      quantization: "awq",
      contextWindow: 65536,
    });
    expect(result.models[0].metadata).toHaveProperty("version.version", "0.10.0");
  });

  it("preserves OpenRouter's complete model record alongside normalized fields", async () => {
    const url = "https://openrouter.ai/api/v1/models?output_modalities=all";
    const raw = {
      id: "openai/gpt-4o-mini",
      canonical_slug: "openai/gpt-4o-mini-2024-07-18",
      name: "OpenAI: GPT-4o mini",
      context_length: 128000,
      top_provider: { context_length: 128000, max_completion_tokens: 16384 },
      pricing: { prompt: "0.00000015", completion: "0.0000006" },
      supported_parameters: ["temperature", "seed"],
      architecture: { input_modalities: ["text"] },
    };
    const { fetchImpl } = endpointFetch({ [url]: { data: [raw] } });
    const result = await discoverProviderModels({
      harness: Harness.OpenRouter,
      baseUrl: "https://openrouter.ai/api/v1",
      modelId: raw.id,
      apiKey: "sk-test",
      fetchImpl,
    });
    expect(result.models[0]).toMatchObject({
      id: raw.id,
      name: raw.name,
      contextWindow: 128000,
      maxCompletionTokens: 16384,
      pricing: { promptUsdPerToken: 1.5e-7, completionUsdPerToken: 6e-7 },
    });
    expect(result.models[0].metadata).toHaveProperty("models.canonical_slug", "openai/gpt-4o-mini-2024-07-18");
  });
});

describe("listModels", () => {
  it("reads a bare /models list under the base URL, skipping malformed entries and unreadable pricing", async () => {
    const base = "https://gateway.example/openai";
    const { fetchImpl } = endpointFetch({
      [`${base}/models`]: {
        data: [
          null,
          3,
          { object: "model" },
          { id: "" },
          {
            id: "acme/chat-7b",
            name: "Acme Chat",
            context_length: 32768,
            pricing: { prompt: "1e-6", completion: "2e-6" },
          },
          { id: "x", pricing: { prompt: "n/a", completion: "0.1" } },
        ],
      },
    });

    expect(await listModels({ baseUrl: `${base}/`, fetchImpl })).toEqual([
      {
        id: "acme/chat-7b",
        name: "",
        contextWindow: 32768,
        pricing: { promptUsdPerToken: 1e-6, completionUsdPerToken: 2e-6 },
        metadata: {},
      },
      { id: "x", name: "", metadata: {} },
    ]);
  });
});
