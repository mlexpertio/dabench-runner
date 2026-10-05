import { CHARS_PER_TOKEN, isTimedWindow } from "./calc";
import { completionTokensOf, type CompletionClient, type StreamHandlers, type StreamResult } from "./client";
import type { CaseTiming } from "./metrics";

const TICK_INTERVAL_MS = 400;

export interface StreamTick {
  phase: "thinking" | "answering";
  reasoningTokens: number;
  contentTokens: number;
  elapsedMs: number;
}

export interface CaseStream extends CompletionClient {
  timing(): CaseTiming;
}

export function createCaseStream(
  client: CompletionClient,
  clock: () => number,
  onTick: ((tick: StreamTick) => void) | undefined,
): CaseStream {
  const tickStart = onTick ? clock() : 0;
  const timing: CaseTiming = { requestMs: 0, timedTokens: 0, timedMs: 0 };
  let lastTickAt = 0;
  let completionStartedAt = 0;
  let firstOutputAt: number | null = null;
  let reasoningChars = 0;
  let contentChars = 0;
  let lastDeltaWasReasoning = false;
  let reasoningStreamed = false;

  const observeOutput = (): void => {
    if (firstOutputAt !== null && !onTick) return;
    const now = clock();
    firstOutputAt ??= now;
    if (!onTick || now - lastTickAt < TICK_INTERVAL_MS) return;
    lastTickAt = now;
    onTick({
      phase: lastDeltaWasReasoning || contentChars === 0 ? "thinking" : "answering",
      reasoningTokens: Math.round(reasoningChars / CHARS_PER_TOKEN),
      contentTokens: Math.round(contentChars / CHARS_PER_TOKEN),
      elapsedMs: now - tickStart,
    });
  };
  const startCompletion = (): void => {
    completionStartedAt = clock();
    firstOutputAt = null;
    reasoningStreamed = false;
  };
  const reasoningWasHidden = (result: StreamResult): boolean =>
    (result.usage?.reasoningTokens ?? 0) > 0 && !reasoningStreamed;

  const handlers: StreamHandlers = {
    onAttempt: startCompletion,
    onDelta: (delta) => {
      contentChars += delta.length;
      lastDeltaWasReasoning = false;
      observeOutput();
    },
    onReasoningDelta: (delta) => {
      reasoningChars += delta.length;
      lastDeltaWasReasoning = true;
      reasoningStreamed = true;
      observeOutput();
    },
    onToolCallDelta: observeOutput,
  };

  return {
    stream: async (request) => {
      startCompletion();
      const result = await client.stream(request, handlers);
      const now = clock();
      timing.requestMs += now - completionStartedAt;
      const generationStartedAt = reasoningWasHidden(result) ? completionStartedAt : firstOutputAt;
      const outputMs = generationStartedAt === null ? 0 : now - generationStartedAt;
      if (isTimedWindow(outputMs)) {
        timing.timedMs += outputMs;
        timing.timedTokens += completionTokensOf(result);
      }
      return result;
    },
    timing: () => ({ ...timing }),
  };
}
