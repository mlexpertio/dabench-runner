import type { CompletionClient, CompletionRequest, StreamResult } from "../src/engine/client";

export type ScriptedReply = string | (Omit<StreamResult, "aborted" | "usage"> & Partial<Pick<StreamResult, "usage">>);

export class ScriptedClient implements CompletionClient {
  readonly requests: CompletionRequest[] = [];

  constructor(private readonly replies: readonly ScriptedReply[]) {}

  async stream(request: CompletionRequest): Promise<StreamResult> {
    this.requests.push(request);
    const reply = this.replies[Math.min(this.requests.length, this.replies.length) - 1];
    return typeof reply === "string"
      ? { text: reply, usage: null, aborted: false }
      : { usage: null, ...reply, aborted: false };
  }
}

export function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
