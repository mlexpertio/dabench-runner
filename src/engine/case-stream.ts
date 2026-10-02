import { CHARS_PER_TOKEN, isTimedWindow } from "./calc";
import { completionTokensOf, type CompletionClient, type StreamHandlers } from "./client";

const TICK_INTERVAL_MS = 400;

export interface StreamTick {
  phase: "thinking" | "answering";
  reasoningTokens: number;
  contentTokens: number;
  elapsedMs: number;
}

interface CaseTiming {
  requestMs: number;
  timedTokens: number;
  timedMs: number;
}

/** One case's completions as they stream: live token ticks, and the time spent answering. */
interface CaseStream extends CompletionClient {
  /** Starts the counts over for a new attempt at the case. */
  restart(): void;
  timing(): CaseTiming;
}

interface AttemptCounts extends CaseTiming {
  reasoningChars: number;
  contentChars: number;
  lastDeltaWasReasoning: boolean;
}

/**
 * Times each completion from its last try, so rate-limit backoff and failed tries don't count,
 * and sums them over the case. The rate times each completion from its first output of any kind,
 * and only when that output streamed long enough to time. A completion whose whole output arrives
 * in one burst adds neither its tokens nor its time.
 */
export function createCaseStream(
  client: CompletionClient,
  clock: () => number,
  onTick: ((tick: StreamTick) => void) | undefined,
): CaseStream {
  const tickStart = onTick ? clock() : 0;
  let lastTickAt = 0;
  let completionStartedAt = 0;
  let firstOutputAt: number | null = null;
  let counts = freshCounts();

  const observeOutput = (): void => {
    if (firstOutputAt !== null && !onTick) return;
    const now = clock();
    firstOutputAt ??= now;
    if (!onTick || now - lastTickAt < TICK_INTERVAL_MS) return;
    lastTickAt = now;
    onTick({
      phase: counts.lastDeltaWasReasoning || counts.contentChars === 0 ? "thinking" : "answering",
      reasoningTokens: Math.round(counts.reasoningChars / CHARS_PER_TOKEN),
      contentTokens: Math.round(counts.contentChars / CHARS_PER_TOKEN),
      elapsedMs: now - tickStart,
    });
  };
  const startCompletion = (): void => {
    completionStartedAt = clock();
    firstOutputAt = null;
  };

  const handlers: StreamHandlers = {
    onAttempt: startCompletion,
    onDelta: (delta) => {
      counts.contentChars += delta.length;
      counts.lastDeltaWasReasoning = false;
      observeOutput();
    },
    onReasoningDelta: (delta) => {
      counts.reasoningChars += delta.length;
      counts.lastDeltaWasReasoning = true;
      observeOutput();
    },
    onToolCallDelta: observeOutput,
  };

  return {
    stream: async (request) => {
      startCompletion();
      const result = await client.stream(request, handlers);
      const now = clock();
      counts.requestMs += now - completionStartedAt;
      const outputMs = firstOutputAt === null ? 0 : now - firstOutputAt;
      if (isTimedWindow(outputMs)) {
        counts.timedMs += outputMs;
        counts.timedTokens += completionTokensOf(result);
      }
      return result;
    },
    restart: () => {
      counts = freshCounts();
    },
    timing: () => ({ requestMs: counts.requestMs, timedTokens: counts.timedTokens, timedMs: counts.timedMs }),
  };
}

function freshCounts(): AttemptCounts {
  return {
    requestMs: 0,
    timedTokens: 0,
    timedMs: 0,
    reasoningChars: 0,
    contentChars: 0,
    lastDeltaWasReasoning: false,
  };
}
