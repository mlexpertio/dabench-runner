import { describe, expect, it } from "vitest";
import { OpenAICompletionClient } from "../src/engine/openai-client";
import { sseResponse } from "./scripted-client";

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

function sseFetch(chunks: unknown[]) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: unknown, init?: { body?: string }) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url: string }).url;
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : {} });
    return sseResponse(chunks);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const STREAM_CHUNKS = [
  { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
];

describe("OpenAICompletionClient.stream — SSE over an OpenAI-compatible endpoint", () => {
  it("accumulates deltas, reports usage, and forwards each delta", async () => {
    const { fetchImpl, calls } = sseFetch(STREAM_CHUNKS);
    const client = new OpenAICompletionClient({
      apiKey: "sk-test",
      baseUrl: "http://localhost:8080/v1/",
      fetchImpl,
    });

    const deltas: string[] = [];
    const result = await client.stream(
      {
        model: "qwen",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 64,
        temperature: 0,
        providerParameters: { top_k: 40, min_p: 0.05 },
      },
      { onDelta: (d) => deltas.push(d) },
    );

    expect(result.text).toBe("Hello");
    expect(result.finishReason).toBe("stop");
    expect(result.aborted).toBe(false);
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 2 });
    expect(deltas).toEqual(["Hel", "lo"]);

    expect(calls[0].url).toBe("http://localhost:8080/v1/chat/completions");
    expect(calls[0].body).toMatchObject({
      model: "qwen",
      max_tokens: 64,
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true },
      top_k: 40,
      min_p: 0.05,
    });
  });

  it("reports a stream stopped mid-answer as aborted", async () => {
    const fetchImpl = (async (_: unknown, init?: { signal?: AbortSignal }) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(STREAM_CHUNKS[1])}\n\n`));
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const client = new OpenAICompletionClient({ apiKey: "x", baseUrl: "http://h/v1", fetchImpl });
    const stop = new AbortController();

    const result = await client.stream(
      { model: "m", messages: [{ role: "user", content: "q" }] },
      { signal: stop.signal, onDelta: () => stop.abort() },
    );

    expect(result).toMatchObject({ text: "Hel", aborted: true });
  });

  it("accumulates reasoning deltas and forwards them apart from content", async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { reasoning: "Let me " }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning: "think." }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "42" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
    ];
    const { fetchImpl } = sseFetch(chunks);
    const client = new OpenAICompletionClient({ apiKey: "x", baseUrl: "http://h/v1", fetchImpl });

    const reasoning: string[] = [];
    const content: string[] = [];
    const result = await client.stream(
      { model: "m", messages: [{ role: "user", content: "q" }] },
      { onDelta: (d) => content.push(d), onReasoningDelta: (d) => reasoning.push(d) },
    );

    expect(result.text).toBe("42");
    expect(result.reasoningText).toBe("Let me think.");
    expect(reasoning).toEqual(["Let me ", "think."]);
    expect(content).toEqual(["42"]);
  });

  it("rebuilds streamed reasoning_details into whole blocks, and reads their text when no scalar reasoning field is sent", async () => {
    const FORMAT = "anthropic-claude-v1";
    const chunks = [
      {
        choices: [
          {
            index: 0,
            delta: { reasoning_details: [{ type: "reasoning.text", text: "Let me ", format: FORMAT, index: 0 }] },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { reasoning_details: [{ type: "reasoning.text", text: "think.", format: FORMAT, index: 0 }] },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { reasoning_details: [{ type: "reasoning.text", signature: "sig-1", format: FORMAT, index: 0 }] },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "blob", format: FORMAT, index: 1 }] },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [{ type: "reasoning.summary", summary: " Checked.", format: FORMAT, index: 2 }],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: { content: "42" }, finish_reason: "stop" }] },
    ];
    const { fetchImpl } = sseFetch(chunks);
    const client = new OpenAICompletionClient({ apiKey: "x", baseUrl: "http://h/v1", fetchImpl });

    const reasoning: string[] = [];
    const result = await client.stream(
      { model: "m", messages: [{ role: "user", content: "q" }] },
      { onReasoningDelta: (delta) => reasoning.push(delta) },
    );

    expect(result.reasoningDetails).toEqual([
      { type: "reasoning.text", text: "Let me think.", signature: "sig-1", format: FORMAT, index: 0 },
      { type: "reasoning.encrypted", data: "blob", format: FORMAT, index: 1 },
      { type: "reasoning.summary", summary: " Checked.", format: FORMAT, index: 2 },
    ]);
    expect(reasoning).toEqual(["Let me ", "think.", " Checked."]);
    expect(result.reasoningText).toBe("Let me think. Checked.");
  });

  it("sends history back as each server reads it: reasoning blocks unchanged, thinking under both names, calls paired with their replies", async () => {
    const { fetchImpl, calls } = sseFetch(STREAM_CHUNKS);
    const client = new OpenAICompletionClient({ apiKey: "x", baseUrl: "http://h/v1", fetchImpl });
    const details = [
      { type: "reasoning.text", text: "t1", signature: "sig-1", format: "anthropic-claude-v1", index: 0 },
    ];

    await client.stream({
      model: "m",
      messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1", reasoning: "t1", reasoningDetails: details },
        { role: "assistant", content: "a2", reasoning: "t2" },
        { role: "assistant", content: "a3" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_0_0", name: "search", args: { q: "sofia" } }] },
        { role: "tool", toolCallId: "call_0_0", content: '{"ok":true}' },
      ],
    });

    expect(calls[0].body.messages).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1", reasoning_details: details },
      { role: "assistant", content: "a2", reasoning: "t2", reasoning_content: "t2" },
      { role: "assistant", content: "a3" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_0_0", type: "function", function: { name: "search", arguments: '{"q":"sofia"}' } }],
      },
      { role: "tool", tool_call_id: "call_0_0", content: '{"ok":true}' },
    ]);
  });

  it("forwards tool definitions and accumulates streamed call fragments, keeping unparseable arguments as text", async () => {
    const SEARCH_PARAMETERS = { type: "object", properties: { q: { type: "string" } } };
    const chunks = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "search", arguments: "" } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"so' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: 'fia"}' } },
                { index: 1, id: "call_2", type: "function", function: { name: "fetch", arguments: "{}" } },
                { index: 2, id: "call_3", type: "function", function: { name: "fetch", arguments: "not json" } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 } },
    ];
    const { fetchImpl, calls } = sseFetch(chunks);
    const client = new OpenAICompletionClient({ apiKey: "x", baseUrl: "http://h/v1", fetchImpl });

    let fragments = 0;
    const result = await client.stream(
      {
        model: "m",
        messages: [{ role: "user", content: "q" }],
        tools: [{ name: "search", description: "web search", parameters: SEARCH_PARAMETERS }, { name: "fetch" }],
      },
      { onToolCallDelta: () => fragments++ },
    );

    expect(fragments).toBe(5);
    expect(calls[0].body.tools).toEqual([
      { type: "function", function: { name: "search", description: "web search", parameters: SEARCH_PARAMETERS } },
      { type: "function", function: { name: "fetch", parameters: { type: "object", properties: {} } } },
    ]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "search", args: { q: "sofia" } },
      { id: "call_2", name: "fetch", args: {} },
      { id: "call_3", name: "fetch", argsText: "not json" },
    ]);
  });
});
