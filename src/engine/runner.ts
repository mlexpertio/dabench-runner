import { aggregate } from "./aggregator";
import { buildArtifact, type CompletedCase, type RunIdentity } from "./artifact";
import type { CostBasis } from "./calc";
import { executeCase, failedExecution, type CaseExecution } from "./case-execution";
import { caseResponse } from "./case-response";
import { createCaseStream, type CaseStream, type StreamTick } from "./case-stream";
import type { CompletionClient, ToolCall } from "./client";
import { grade } from "./grader";
import { errorMessage } from "./guards";
import {
  caseMetrics,
  mergeMemory,
  recordedOutput,
  runCost,
  runMetrics,
  type CaseTiming,
  type MeasuredCase,
} from "./metrics";
import type { Artifact, CaseResult, MemoryKind, MemoryUsage, ToolCallRecord } from "./schema";
import type { Suite, TestCase } from "./suite";

const CASE_ATTEMPTS = 2;

interface CaseStart {
  index: number;
  total: number;
  caseId: string;
  category: string;
}

interface CaseError extends CaseStart {
  message: string;
}

interface RunTick extends CaseStart, StreamTick {}

interface RunProgress extends CaseStart {
  score: number;
  elapsedMs: number;
}

export interface RunObserver {
  onCaseStart?: (c: CaseStart) => void;
  onCaseTick?: (t: RunTick) => void;
  onCaseError?: (e: CaseError) => void;
  onProgress?: (p: RunProgress) => void;
}

export interface MemoryMonitor {
  probe(): Promise<{ mb: number; kind: MemoryKind } | null>;
  usage(): MemoryUsage | null;
}

interface RunBenchmarkOptions extends RunObserver {
  identity: RunIdentity;
  client: CompletionClient;
  cost: CostBasis;
  memoryMonitor?: MemoryMonitor;
  resumeFrom?: Artifact;
  clock?: () => number;
  onCheckpoint?: (artifact: Artifact, completed: CompletedCase) => void | Promise<void>;
}

interface CaseRun {
  result: CaseResult;
  timed: MeasuredCase["timed"];
}

interface TimedExecution {
  execution: CaseExecution;
  timing: CaseTiming;
}

export async function runBenchmark(opts: RunBenchmarkOptions): Promise<Artifact> {
  const { identity, resumeFrom, memoryMonitor } = opts;
  const { cases } = identity.suite;
  const clock = opts.clock ?? Date.now;
  const resumed = (resumeFrom?.caseResults ?? []).map((result) => ({ result, timed: recordedOutput(result.metrics) }));
  const recorded = new Set(resumed.map(({ result }) => result.caseId));
  const priorMemory = resumeFrom?.metrics.memory ?? null;
  const runs = [...resumed];
  const memorySoFar = () => mergeMemory(priorMemory, memoryMonitor?.usage() ?? null);

  for (const [suiteIndex, testCase] of cases.entries()) {
    if (recorded.has(testCase.id)) continue;
    const caseStart = { index: suiteIndex + 1, total: cases.length, caseId: testCase.id, category: testCase.category };
    const run = await runCase(opts, clock, testCase, caseStart);
    runs.push(run);
    await opts.onCheckpoint?.(assembleArtifact(opts, runs, memorySoFar()), { result: run.result, suiteIndex });
    opts.onProgress?.({ ...caseStart, score: run.result.score, elapsedMs: run.result.metrics.latencyMs });
  }

  return assembleArtifact(opts, runs, memorySoFar());
}

async function runCase(
  opts: RunBenchmarkOptions,
  clock: () => number,
  testCase: TestCase,
  caseStart: CaseStart,
): Promise<CaseRun> {
  const { identity, onCaseTick } = opts;
  opts.onCaseStart?.(caseStart);
  const target = {
    model: identity.model.id,
    config: identity.config,
    generation: identity.suite.categories.find((category) => category.slug === testCase.category)!.generation,
  };

  const { execution, timing } = await executeWithRetry(
    () => createCaseStream(opts.client, clock, onCaseTick && ((tick) => onCaseTick({ ...caseStart, ...tick }))),
    (stream) => executeCase(stream, testCase, target),
    (message) => opts.onCaseError?.({ ...caseStart, message }),
  );
  const memorySample = (await opts.memoryMonitor?.probe()) ?? null;

  const metrics = caseMetrics({
    promptTokens: execution.usage.promptTokens,
    completionTokens: execution.usage.completionTokens,
    reasoningTokens: execution.usage.reasoningTokens,
    ...timing,
    vramMb: memorySample ? memorySample.mb : null,
  });
  const graded = await grade(testCase, execution);
  return {
    result: {
      caseId: testCase.id,
      category: testCase.category,
      graderKind: testCase.graderKind,
      score: graded.score,
      correctness: graded.correctness,
      quality: graded.quality,
      assertions: graded.assertions,
      response: caseResponse(execution.text, execution.toolCalls),
      ...(execution.reasoningText ? { reasoning: execution.reasoningText } : {}),
      finishReason: execution.finishReason ?? null,
      ...(execution.toolCalls ? { toolCalls: execution.toolCalls.map(recordedCall) } : {}),
      metrics,
    },
    timed: timing,
  };
}

async function executeWithRetry(
  newStream: () => CaseStream,
  attempt: (stream: CaseStream) => Promise<CaseExecution>,
  onError: (message: string) => void,
  attemptsLeft = CASE_ATTEMPTS,
): Promise<TimedExecution> {
  const stream = newStream();
  try {
    return { execution: await attempt(stream), timing: stream.timing() };
  } catch (err) {
    if (attemptsLeft > 1) return executeWithRetry(newStream, attempt, onError, attemptsLeft - 1);
    onError(errorMessage(err));
    return { execution: failedExecution(), timing: stream.timing() };
  }
}

function assembleArtifact(opts: RunBenchmarkOptions, runs: CaseRun[], memory: MemoryUsage | null): Artifact {
  const { identity } = opts;
  const caseResults = inSuiteOrder(
    runs.map((run) => run.result),
    identity.suite,
  );
  const metrics = runMetrics(
    runs.map(({ result, timed }) => ({ metrics: result.metrics, timed })),
    memory,
  );
  return buildArtifact(identity, {
    caseResults,
    categoryScores: aggregate(
      caseResults,
      identity.suite.categories.map((category) => category.slug),
    ),
    metrics,
    cost: runCost(metrics, opts.cost),
  });
}

function inSuiteOrder(results: CaseResult[], suite: Suite): CaseResult[] {
  const order = new Map(suite.cases.map((testCase, index) => [testCase.id, index]));
  return [...results].sort((a, b) => (order.get(a.caseId) ?? Infinity) - (order.get(b.caseId) ?? Infinity));
}

function recordedCall({ name, args }: ToolCall): ToolCallRecord {
  return args ? { name, args } : { name };
}
