import { estimateTokens } from "./calc";
import type { JsonObject } from "./guards";

export type MessageContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ToolCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
  argsText?: string;
}

export type IssuedToolCall = ToolCall & { id: string };

/** The arguments as the model sent them, whether or not they parsed. */
export function callArguments(call: ToolCall): string {
  return call.argsText ?? JSON.stringify(call.args ?? {});
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | MessageContentPart[] }
  | {
      role: "assistant";
      content: string;
      reasoning?: string;
      reasoningDetails?: JsonObject[];
      toolCalls?: IssuedToolCall[];
    }
  | { role: "tool"; content: string; toolCallId: string };

export interface ToolParam {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

function messageContentToText(content: string | MessageContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function messageText(message: ChatMessage): string {
  const content = messageContentToText(message.content);
  return message.role === "assistant" && message.reasoning ? `${message.reasoning}\n${content}` : content;
}

export function estimatePromptTokens(messages: ChatMessage[]): number {
  return estimateTokens(messages.map(messageText).join("\n"));
}

/** The reply's output tokens as the provider reported them, else estimated from its text and reasoning. */
export function completionTokensOf(result: StreamResult): number {
  return result.usage?.completionTokens ?? estimateTokens(result.text) + estimateTokens(result.reasoningText ?? "");
}

interface JsonSchemaResponseFormat {
  name: string;
  schema: Record<string, unknown>;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: JsonSchemaResponseFormat;
  tools?: ToolParam[];
  providerParameters?: Record<string, unknown>;
}

export interface CompletionUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
}

export interface StreamHandlers {
  /** Called as each try of the request starts, so a retried request can be timed from its last try. */
  onAttempt?: () => void;
  onDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  /** Called for each streamed fragment of a tool call. */
  onToolCallDelta?: () => void;
  signal?: AbortSignal;
}

export interface StreamResult {
  text: string;
  usage: CompletionUsage | null;
  finishReason?: string;
  aborted: boolean;
  toolCalls?: ToolCall[];
  reasoningText?: string;
  /** The provider's own reasoning blocks (OpenRouter `reasoning_details`), to send back unchanged. */
  reasoningDetails?: JsonObject[];
  model?: string;
}

export interface CompletionClient {
  stream(request: CompletionRequest, handlers?: StreamHandlers): Promise<StreamResult>;
}
