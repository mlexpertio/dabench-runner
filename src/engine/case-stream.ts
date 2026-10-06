import { CHARS_PER_TOKEN, isTimedWindow } from "./calc";
import { completionTokensOf, type CompletionClient, type StreamHandlers, type StreamResult } from "./client";
import type { CaseTiming } from "./metrics";

const TICK_INTERVAL_MS = 400;

export enum StreamPhase {
  Thinking = "thinking",
  Answering = "answering",
  CallingTools = "calling-tools",
}

export interface StreamTick {
  phase: StreamPhase;
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
  let lastTickPhase: StreamPhase | null = null;
  let completionStartedAt = 0;
  let firstOutputAt: number | null = null;
  let reasoningChars = 0;
  let contentChars = 0;
  let reasoningStreamed = false;

  const observeOutput = (phase: StreamPhase): void => {
    if (firstOutputAt !== null && !onTick) return;
    const now = clock();
    firstOutputAt ??= now;
    if (!onTick || (phase === lastTickPhase && now - lastTickAt < TICK_INTERVAL_MS)) return;
    lastTickAt = now;
    lastTickPhase = phase;
    onTick({
      phase,
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
      observeOutput(StreamPhase.Answering);
    },
    onReasoningDelta: (delta) => {
      reasoningChars += delta.length;
      reasoningStreamed = true;
      observeOutput(StreamPhase.Thinking);
    },
    onToolCallDelta: () => observeOutput(StreamPhase.CallingTools),
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
