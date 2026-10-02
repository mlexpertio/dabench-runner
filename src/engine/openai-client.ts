import OpenAI from "openai";
import pRetry from "p-retry";
import {
  callArguments,
  type ChatMessage,
  type CompletionClient,
  type CompletionRequest,
  type CompletionUsage,
  type IssuedToolCall,
  type StreamHandlers,
  type StreamResult,
  type ToolCall,
  type ToolParam,
} from "./client";
import { errorMessage, isRecord, type JsonObject } from "./guards";

export interface RetryOptions {
  retries: number;
  minTimeoutMs: number;
  maxTimeoutMs: number;
  onRetry: (info: { retriesLeft: number; delayMs: number; status?: number; message: string }) => void;
}

interface OpenAICompletionClientOptions {
  apiKey: string;
  baseUrl?: string;
  defaultHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
  allowBrowser?: boolean;
  retry?: RetryOptions;
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const RETRY_BACKOFF_FACTOR = 2;
const STREAMED_DETAIL_TEXT_KEYS = new Set(["text", "summary", "data"]);
export const NO_API_KEY = "no-key";

type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;
type ChatParams = Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, "stream" | "stream_options">;

export class OpenAICompletionClient implements CompletionClient {
  private readonly client: OpenAI;
  private readonly retry?: RetryOptions;

  constructor(opts: OpenAICompletionClientOptions) {
    if (!opts.apiKey) throw new Error("OpenAICompletionClient requires an apiKey");
    this.retry = opts.retry;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl?.replace(/\/+$/, ""),
      defaultHeaders: opts.defaultHeaders,
      fetch: opts.fetchImpl,
      dangerouslyAllowBrowser: opts.allowBrowser,
      ...(opts.retry ? { maxRetries: 0 } : {}),
    });
  }

  private withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const cfg = this.retry;
    if (!cfg) return fn();
    return pRetry(fn, {
      retries: cfg.retries,
      factor: RETRY_BACKOFF_FACTOR,
      minTimeout: cfg.minTimeoutMs,
      maxTimeout: cfg.maxTimeoutMs,
      randomize: true,
      shouldRetry: ({ error }) => isRetryable(error),
      onFailedAttempt: ({ error, retriesLeft, retryDelay }) => {
        if (retriesLeft > 0 && isRetryable(error)) {
          cfg.onRetry({
            retriesLeft,
            delayMs: retryDelay,
            status: errorStatus(error),
            message: errorMessage(error),
          });
        }
      },
    });
  }

  async stream(request: CompletionRequest, handlers?: StreamHandlers): Promise<StreamResult> {
    let text = "";
    let reasoning = "";
    const reasoningDetails: JsonObject[] = [];
    let usage: CompletionUsage | null = null;
    let finishReason: string | undefined;
    let model: string | undefined;
    const toolCallParts = new Map<number, { id?: string; name: string; args: string }>();
    let abortThrown = false;

    try {
      const completion = await this.withRetry(() => {
        handlers?.onAttempt?.();
        return this.client.chat.completions.create(
          {
            ...chatParams(request),
            stream: true,
            stream_options: { include_usage: true },
            response_format: responseFormat(request),
          },
          { signal: handlers?.signal },
        );
      });

      for await (const chunk of completion) {
        if (chunk.model) model = chunk.model;
        const choice = chunk.choices?.[0];
        const delta = choice?.delta?.content ?? "";
        if (delta) {
          text += delta;
          handlers?.onDelta?.(delta);
        }
        const reasoningDelta = reasoningTextFrom(choice?.delta);
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          handlers?.onReasoningDelta?.(reasoningDelta);
        }
        mergeReasoningDetails(reasoningDetails, choice?.delta);
        for (const fragment of choice?.delta?.tool_calls ?? []) {
          const part = toolCallParts.get(fragment.index) ?? { name: "", args: "" };
          if (fragment.id) part.id = fragment.id;
          if (fragment.function?.name) part.name += fragment.function.name;
          if (fragment.function?.arguments) part.args += fragment.function.arguments;
          toolCallParts.set(fragment.index, part);
          handlers?.onToolCallDelta?.();
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) usage = usageFrom(chunk.usage);
      }
    } catch (err) {
      if (!isAbortError(err)) throw err;
      abortThrown = true;
    }

    const received = {
      text,
      usage,
      finishReason,
      reasoningText: reasoning || undefined,
      reasoningDetails: reasoningDetails.length > 0 ? reasoningDetails : undefined,
      model,
    };
    if (abortThrown || handlers?.signal?.aborted) return { ...received, aborted: true };

    const toolCalls = [...toolCallParts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, part]) => normalizeToolCall(part.id, part.name, part.args));
    return { ...received, aborted: false, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
  }
}

function chatParams(request: CompletionRequest): ChatParams {
  return {
    ...request.providerParameters,
    model: request.model,
    messages: request.messages.map(toOpenAIMessage),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    ...(request.tools ? { tools: toOpenAITools(request.tools) } : {}),
  };
}

function responseFormat(request: CompletionRequest): ChatParams["response_format"] {
  if (!request.responseFormat) return undefined;
  return {
    type: "json_schema",
    json_schema: {
      name: request.responseFormat.name,
      strict: false,
      schema: request.responseFormat.schema,
    },
  };
}

function usageFrom(usage: OpenAI.Completions.CompletionUsage | undefined): CompletionUsage {
  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    reasoningTokens: reasoningTokensFrom(usage),
  };
}

function toOpenAIMessage(m: ChatMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.content };
    case "user":
      return { role: "user", content: m.content };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    case "assistant":
      return { ...toOpenAIAssistantMessage(m), ...replayedReasoning(m) };
  }
}

function toOpenAIAssistantMessage(m: AssistantMessage): OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam {
  return m.toolCalls?.length
    ? { role: "assistant", content: m.content || null, tool_calls: m.toolCalls.map(toOpenAIToolCall) }
    : { role: "assistant", content: m.content };
}

/**
 * OpenRouter takes its own `reasoning_details` back unchanged. For plain text, Ollama reads `reasoning`,
 * llama.cpp, SGLang and DeepSeek read `reasoning_content`, vLLM reads either, and each ignores the other.
 */
function replayedReasoning({ reasoning, reasoningDetails }: AssistantMessage) {
  if (reasoningDetails?.length) return { reasoning_details: reasoningDetails };
  return reasoning ? { reasoning, reasoning_content: reasoning } : {};
}

function toOpenAIToolCall(call: IssuedToolCall): OpenAI.Chat.Completions.ChatCompletionMessageToolCall {
  return {
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: callArguments(call) },
  };
}

function toOpenAITools(tools: ToolParam[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.parameters ?? { type: "object", properties: {} },
    },
  }));
}

function normalizeToolCall(id: string | undefined, name: string, argsText: string): ToolCall {
  try {
    const parsed: unknown = argsText.trim() === "" ? {} : JSON.parse(argsText);
    if (isRecord(parsed)) return { id, name, args: parsed };
  } catch {}
  return { id, name, argsText };
}

function reasoningTokensFrom(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined;
  const details = usage.completion_tokens_details;
  const detail = isRecord(details) ? details.reasoning_tokens : undefined;
  const flat = usage.reasoning_tokens;
  const value = typeof detail === "number" ? detail : typeof flat === "number" ? flat : undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function reasoningTextFrom(source: unknown): string {
  if (!isRecord(source)) return "";
  if (typeof source.reasoning === "string") return source.reasoning;
  if (typeof source.reasoning_content === "string") return source.reasoning_content;
  return reasoningDetailsText(source.reasoning_details);
}

function reasoningDetailsText(details: unknown): string {
  if (!Array.isArray(details)) return "";
  return details
    .map((detail) => {
      if (!isRecord(detail)) return "";
      if (typeof detail.text === "string") return detail.text;
      if (typeof detail.summary === "string") return detail.summary;
      return "";
    })
    .join("");
}

/** A streamed block arrives in fragments that share its `index`; their texts join and later fields win. */
function mergeReasoningDetails(blocks: JsonObject[], delta: unknown): void {
  if (!isRecord(delta) || !Array.isArray(delta.reasoning_details)) return;
  for (const fragment of delta.reasoning_details.filter(isRecord) as JsonObject[]) {
    const block = typeof fragment.index === "number" ? blocks.find((b) => b.index === fragment.index) : undefined;
    if (block) appendDetailFragment(block, fragment);
    else blocks.push({ ...fragment });
  }
}

function appendDetailFragment(block: JsonObject, fragment: JsonObject): void {
  for (const [key, value] of Object.entries(fragment)) {
    const current = block[key];
    if (STREAMED_DETAIL_TEXT_KEYS.has(key) && typeof current === "string" && typeof value === "string") {
      block[key] = current + value;
    } else if (value !== null) {
      block[key] = value;
    }
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError");
}

function isRetryable(err: unknown): boolean {
  if (isAbortError(err)) return false;
  const status = errorStatus(err);
  return status === undefined || RETRYABLE_STATUS.has(status);
}

function errorStatus(err: unknown): number | undefined {
  return isRecord(err) && typeof err.status === "number" ? err.status : undefined;
}
