import { aggregate } from "./aggregator";
import { buildArtifact, type RunIdentity } from "./artifact";
import type { CostBasis } from "./calc";
import { executeCase, failedExecution, type CaseExecution } from "./case-execution";
import { caseResponse } from "./case-response";
import type { SelectedCase } from "./case-selection";
import { createCaseStream, type StreamTick } from "./case-stream";
import type { CompletionClient, ToolCall } from "./client";
import { grade } from "./grader";
import { errorMessage } from "./guards";
import type { MemoryMonitor } from "./memory";
import { caseMetrics, mergeMemory, runCost, runMetrics } from "./metrics";
import type { Artifact, CaseResult, MemoryUsage, ModelRef, ToolCallRecord } from "./schema";
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

export interface CompletedCase {
  result: CaseResult;
  suiteIndex: number;
}

export interface RunObserver {
  onCaseStart?: (c: CaseStart) => void;
  onCaseTick?: (t: RunTick) => void;
  onCaseError?: (e: CaseError) => void;
  onProgress?: (p: RunProgress) => void;
}

interface RunBenchmarkOptions extends RunObserver {
  identity: RunIdentity;
  client: CompletionClient;
  cost: CostBasis;
  cases: readonly SelectedCase[];
  memoryMonitor?: MemoryMonitor;
  /** A compatible run whose recorded cases are kept rather than run again. */
  resumeFrom?: Artifact;
  clock?: () => number;
  onCheckpoint?: (artifact: Artifact, completed: CompletedCase) => void | Promise<void>;
}

interface CaseRun {
  result: CaseResult;
  model?: string;
}

export async function runBenchmark(opts: RunBenchmarkOptions): Promise<Artifact> {
  const { cases, resumeFrom, memoryMonitor } = opts;
  const clock = opts.clock ?? Date.now;
  const recorded = new Set(resumeFrom?.caseResults.map((result) => result.caseId));
  const priorMemory = resumeFrom?.metrics.memory ?? null;
  const runs: CaseRun[] = [];

  const runsCases = cases.some(({ testCase }) => !recorded.has(testCase.id));
  if (runsCases) memoryMonitor?.start();
  let sessionMemory: MemoryUsage | null = null;
  try {
    for (const [position, { testCase, suiteIndex }] of cases.entries()) {
      if (recorded.has(testCase.id)) continue;
      const caseStart = { index: position + 1, total: cases.length, caseId: testCase.id, category: testCase.category };
      const run = await runCase(opts, clock, testCase, caseStart);
      runs.push(run);
      const memorySoFar = mergeMemory(priorMemory, memoryMonitor?.usage() ?? null);
      await opts.onCheckpoint?.(assembleArtifact(opts, runs, memorySoFar), { result: run.result, suiteIndex });
      opts.onProgress?.({ ...caseStart, score: run.result.score, elapsedMs: run.result.metrics.latencyMs });
    }
  } finally {
    if (runsCases) sessionMemory = (await memoryMonitor?.stop()) ?? null;
  }

  return assembleArtifact(opts, runs, mergeMemory(priorMemory, sessionMemory));
}

async function runCase(
  opts: RunBenchmarkOptions,
  clock: () => number,
  testCase: TestCase,
  caseStart: CaseStart,
): Promise<CaseRun> {
  const { identity, onCaseTick } = opts;
  opts.onCaseStart?.(caseStart);
  const stream = createCaseStream(opts.client, clock, onCaseTick && ((tick) => onCaseTick({ ...caseStart, ...tick })));
  const target = {
    model: identity.model.id,
    config: identity.config,
    generation: identity.suite.categories.find((category) => category.slug === testCase.category)!.generation,
  };

  const execution = await executeWithRetry(
    () => {
      stream.restart();
      return executeCase(stream, testCase, target);
    },
    (message) => opts.onCaseError?.({ ...caseStart, message }),
  );
  const memorySample = (await opts.memoryMonitor?.probe()) ?? null;

  const metrics = caseMetrics({
    promptTokens: execution.usage.promptTokens,
    completionTokens: execution.usage.completionTokens,
    reasoningTokens: execution.usage.reasoningTokens,
    ...stream.timing(),
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
    model: execution.model,
  };
}

async function executeWithRetry(
  attempt: () => Promise<CaseExecution>,
  onError: (message: string) => void,
  attemptsLeft = CASE_ATTEMPTS,
): Promise<CaseExecution> {
  try {
    return await attempt();
  } catch (err) {
    if (attemptsLeft > 1) return executeWithRetry(attempt, onError, attemptsLeft - 1);
    onError(errorMessage(err));
    return failedExecution();
  }
}

function assembleArtifact(opts: RunBenchmarkOptions, runs: CaseRun[], memory: MemoryUsage | null): Artifact {
  const { identity, resumeFrom } = opts;
  const caseResults = inSuiteOrder(
    [...(resumeFrom?.caseResults ?? []), ...runs.map((run) => run.result)],
    identity.suite,
  );
  const metrics = runMetrics(
    caseResults.map((result) => result.metrics),
    memory,
  );
  return buildArtifact(
    { ...identity, model: resolvedModel(identity.model, resumeFrom?.model, runs) },
    {
      caseResults,
      categoryScores: aggregate(
        caseResults,
        identity.suite.categories.map((category) => category.slug),
      ),
      metrics,
      cost: runCost(metrics, opts.cost),
    },
  );
}

function resolvedModel(model: ModelRef, prior: ModelRef | undefined, runs: CaseRun[]): ModelRef {
  const priorIds = prior?.metadata?.resolvedModelIds;
  const resolvedIds = new Set([
    ...(Array.isArray(priorIds) ? priorIds.filter((id): id is string => typeof id === "string") : []),
    ...runs.flatMap((run) => (run.model ? [run.model] : [])),
  ]);
  if (resolvedIds.size === 0) return model;
  return {
    ...model,
    metadata: {
      ...prior?.metadata,
      ...model.metadata,
      requestedId: model.id,
      resolvedModelIds: [...resolvedIds],
    },
  };
}

function inSuiteOrder(results: CaseResult[], suite: Suite): CaseResult[] {
  const order = new Map(suite.cases.map((testCase, index) => [testCase.id, index]));
  return [...results].sort((a, b) => (order.get(a.caseId) ?? Infinity) - (order.get(b.caseId) ?? Infinity));
}

function recordedCall({ name, args }: ToolCall): ToolCallRecord {
  return args ? { name, args } : { name };
}
