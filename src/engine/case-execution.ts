import { EDIT_FORMAT_INSTRUCTIONS } from "./code-edits";
import {
  callArguments,
  completionTokensOf,
  estimatePromptTokens,
  type ChatMessage,
  type CompletionClient,
  type CompletionRequest,
  type CompletionUsage,
  type IssuedToolCall,
  type StreamResult,
  type ToolCall,
} from "./client";
import { withSuiteBudgets } from "./generation";
import { reasoningTagChars, stripReasoning } from "./inline-reasoning";
import { toStandardJsonSchema } from "./json-schema";
import type { CategoryGeneration, ModelConfig, ToolCallRecord } from "./schema";
import { CODE_LANGUAGE, type CannedToolResult, type TestCase, type ToolTraceCase } from "./suite";
import { ToolEnvironment } from "./tool-environment";
import { callMatches } from "./tool-match";

export interface CaseExecution {
  text: string;
  earlierReplies: string[];
  toolCalls?: ToolCall[];
  usage: Required<CompletionUsage>;
  finishReason?: string;
  reasoningText?: string;
}

interface CaseTarget {
  model: string;
  config: ModelConfig;
  generation: CategoryGeneration;
}

interface ToolResponder {
  maxTurns: number;
  answer(call: ToolCall): unknown;
}

type Completion = StreamResult & { usage: CompletionUsage };
type FollowUp = (completion: Completion, turn: number) => ChatMessage[] | null;

const DEFAULT_TOOL_ACK = { ok: true };
const MIN_TOOL_TURNS = 8;
const TOOL_TURN_HEADROOM = 2;
const CODE_FENCE = "```";
const SQL_INSTRUCTIONS =
  "Answer with one SQLite query in a ```sql code block. It runs read-only against a database with this schema:";
const FAILED_FINISH_REASON = "error";
const GENERATED_CALL_ID_PREFIX = "call";

export function failedExecution(): CaseExecution {
  return {
    text: "",
    earlierReplies: [],
    usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 },
    finishReason: FAILED_FINISH_REASON,
  };
}

export function executeCase(client: CompletionClient, testCase: TestCase, target: CaseTarget): Promise<CaseExecution> {
  const request = buildCaseRequest(testCase, target);
  if (testCase.graderKind === "tool-state") {
    return runToolLoop(client, request, new ToolEnvironment(testCase.environment));
  }
  if (testCase.graderKind === "tooltrace") return runToolLoop(client, request, new CannedResults(testCase));
  const followUps = testCase.prompt.turns ?? [];
  return runTurns(client, request, followUps.length + 1, ({ text }, turn) =>
    turn < followUps.length ? [answerOnlyReply(text), { role: "user", content: followUps[turn] }] : null,
  );
}

function answerOnlyReply(text: string, toolCalls?: IssuedToolCall[]): ChatMessage {
  return { role: "assistant", content: stripReasoning(text), ...(toolCalls ? { toolCalls } : {}) };
}

async function runToolLoop(
  client: CompletionClient,
  request: CompletionRequest,
  responder: ToolResponder,
): Promise<CaseExecution> {
  const toolCalls: IssuedToolCall[] = [];
  const execution = await runTurns(client, request, responder.maxTurns, (completion, turn) => {
    const calls = (completion.toolCalls ?? []).map((call, i) => ({
      ...call,
      id: call.id ?? `${GENERATED_CALL_ID_PREFIX}_${turn}_${i}`,
    }));
    if (calls.length === 0) return null;
    toolCalls.push(...calls);
    return [
      answerOnlyReply(completion.text, calls),
      ...calls.map((call): ChatMessage => ({
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify(responder.answer(call)),
      })),
    ];
  });
  return { ...execution, toolCalls };
}

async function runTurns(
  client: CompletionClient,
  request: CompletionRequest,
  maxTurns: number,
  followUp: FollowUp,
): Promise<CaseExecution> {
  const messages = [...request.messages];
  const exchange = new Exchange();
  for (let turn = 0; turn < maxTurns; turn++) {
    const completion = await runCompletion(client, { ...request, messages: [...messages] });
    exchange.record(completion);
    const next = followUp(completion, turn);
    if (!next) break;
    messages.push(...next);
  }
  return exchange.execution();
}

function userText(testCase: TestCase): string {
  const { user } = testCase.prompt;
  if (testCase.graderKind === "sql") {
    return `${user}\n\n${SQL_INSTRUCTIONS}\n\n${CODE_FENCE}sql\n${testCase.sql.schema.trimEnd()}\n${CODE_FENCE}`;
  }
  if (testCase.graderKind === "unit-test" && testCase.unitTests.editFile !== undefined) {
    return `${user}\n\n${EDIT_FORMAT_INSTRUCTIONS}\n\n${CODE_FENCE}${CODE_LANGUAGE}\n${testCase.unitTests.editFile}${CODE_FENCE}`;
  }
  return user;
}

function buildCaseRequest(testCase: TestCase, target: CaseTarget): CompletionRequest {
  const messages: ChatMessage[] = [];
  if (testCase.prompt.system) messages.push({ role: "system", content: testCase.prompt.system });
  messages.push({ role: "user", content: userText(testCase) });
  const tools = testCase.graderKind === "tooltrace" || testCase.graderKind === "tool-state" ? testCase.tools : [];

  return {
    model: target.model,
    messages,
    temperature: target.config.temperature ?? undefined,
    providerParameters: withSuiteBudgets(target.config.harness, target.config.providerParameters, target.generation),
    ...(tools.length > 0
      ? {
          tools: tools.map((t) => ({
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            ...(t.parameters ? { parameters: toStandardJsonSchema(t.parameters) } : {}),
          })),
        }
      : {}),
  };
}

class Exchange {
  private readonly usage: CompletionUsage = { promptTokens: 0, completionTokens: 0 };
  private readonly replies: string[] = [];
  private reasoning = "";
  private reasoningChars = 0;
  private answerChars = 0;
  private finishReason: string | undefined;

  record(completion: Completion): void {
    const { text, reasoningText } = completion;
    addUsage(this.usage, completion.usage);
    const inlineReasoningChars = reasoningText ? 0 : reasoningTagChars(text);
    this.reasoningChars += reasoningText ? reasoningText.length : inlineReasoningChars;
    this.answerChars += text.length - inlineReasoningChars + callsChars(completion.toolCalls ?? []);
    if (reasoningText) this.reasoning += (this.reasoning ? "\n" : "") + reasoningText;
    this.replies.push(text);
    this.finishReason = completion.finishReason;
  }

  execution(): CaseExecution {
    const { usage } = this;
    return {
      text: this.replies.at(-1) ?? "",
      earlierReplies: this.replies.slice(0, -1),
      usage: {
        ...usage,
        reasoningTokens:
          usage.reasoningTokens ?? splitReasoningTokens(usage.completionTokens, this.reasoningChars, this.answerChars),
      },
      finishReason: this.finishReason,
      reasoningText: this.reasoning || undefined,
    };
  }
}

function splitReasoningTokens(completionTokens: number, reasoningChars: number, answerChars: number): number {
  if (reasoningChars <= 0) return 0;
  if (answerChars <= 0) return completionTokens;
  return Math.round(completionTokens * (reasoningChars / (reasoningChars + answerChars)));
}

function addUsage(total: CompletionUsage, usage: CompletionUsage): void {
  total.promptTokens += usage.promptTokens;
  total.completionTokens += usage.completionTokens;
  if (usage.reasoningTokens !== undefined) total.reasoningTokens = (total.reasoningTokens ?? 0) + usage.reasoningTokens;
}

function callsChars(calls: readonly ToolCall[]): number {
  return calls.reduce((sum, call) => sum + call.name.length + callArguments(call).length, 0);
}

class CannedResults implements ToolResponder {
  readonly maxTurns: number;
  private readonly entries: CannedToolResult[];
  private readonly spent = new Set<CannedToolResult>();

  constructor(testCase: ToolTraceCase) {
    this.entries = testCase.toolResults ?? [];
    this.maxTurns =
      testCase.toolOptions?.maxTurns ?? Math.max(MIN_TOOL_TURNS, testCase.expectedTools.length + TOOL_TURN_HEADROOM);
  }

  answer(call: ToolCallRecord): unknown {
    const entry = this.entries.find((e) => !this.spent.has(e) && callMatches(e, call));
    if (!entry) return DEFAULT_TOOL_ACK;
    if (entry.once) this.spent.add(entry);
    return entry.result;
  }
}

async function runCompletion(client: CompletionClient, request: CompletionRequest): Promise<Completion> {
  const result = await client.stream(request);
  return { ...result, usage: result.usage ?? estimatedUsage(request, result) };
}

function estimatedUsage(request: CompletionRequest, result: StreamResult): CompletionUsage {
  return { promptTokens: estimatePromptTokens(request.messages), completionTokens: completionTokensOf(result) };
}
