import { splitReasoningTokens } from "./calc";
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
import { generationParameters } from "./generation";
import { callMatches } from "./tool-match";
import { reasoningTagChars, stripReasoning } from "./inline-reasoning";
import type { CategoryGeneration, ModelConfig, ToolCallRecord } from "./schema";
import { toStandardJsonSchema } from "./json-schema";
import { EDIT_FORMAT_INSTRUCTIONS } from "./code-edits";
import { CODE_LANGUAGE, type CannedToolResult, type TestCase, type ToolTraceCase } from "./suite";

export interface CaseExecution {
  text: string;
  earlierReplies: string[];
  toolCalls?: ToolCall[];
  usage: Required<CompletionUsage>;
  finishReason?: string;
  reasoningText?: string;
  model?: string;
}

interface CaseTarget {
  model: string;
  config: ModelConfig;
  generation: CategoryGeneration;
}

type Completion = StreamResult & { usage: CompletionUsage };

const DEFAULT_TOOL_ACK = { ok: true };
const MIN_TOOL_TURNS = 8;
const TOOL_TURN_HEADROOM = 2;
const CODE_FENCE = "```";
const SQL_INSTRUCTIONS =
  "Answer with one SQLite query in a ```sql code block. It runs read-only against a database with this schema:";
const RESPONSE_FORMAT_NAME_MAX_LENGTH = 64;
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

export async function executeCase(
  client: CompletionClient,
  testCase: TestCase,
  target: CaseTarget,
): Promise<CaseExecution> {
  const request = buildCaseRequest(testCase, target);
  if (testCase.graderKind === "tooltrace") return runToolLoop(client, new CannedResults(testCase), request);
  return runConversation(client, request, "turns" in testCase.prompt ? (testCase.prompt.turns ?? []) : []);
}

/**
 * A reply sent back as history: its answer text only, the way a Chat Completions client sends it.
 * Reasoning never goes back, inline or reported separately, so every model sees the same kind of history.
 */
function earlierReply(text: string, toolCalls?: IssuedToolCall[]): ChatMessage {
  return { role: "assistant", content: stripReasoning(text), ...(toolCalls ? { toolCalls } : {}) };
}

/** The first message, then each scripted follow-up after the model's previous reply. The last reply is the answer. */
async function runConversation(
  client: CompletionClient,
  request: CompletionRequest,
  followUps: string[],
): Promise<CaseExecution> {
  const messages = [...request.messages];
  const exchange = new Exchange();
  let reply = "";

  for (const followUp of [null, ...followUps]) {
    if (followUp !== null) {
      messages.push(earlierReply(reply), { role: "user", content: followUp });
    }
    const completion = await runCompletion(client, { ...request, messages: [...messages] });
    exchange.record(completion);
    reply = completion.text;
  }

  return exchange.execution();
}

/** The user message, with what the engine adds for the grader: the answer's JSON Schema or the file to edit. */
function userText(testCase: TestCase, answerSchema: Record<string, unknown> | undefined): string {
  const { user } = testCase.prompt;
  if (answerSchema) {
    return `${user}\n\nYour answer must be a single JSON value conforming to this JSON Schema:\n${JSON.stringify(answerSchema, null, 2)}`;
  }
  if (testCase.graderKind === "sql") {
    return `${user}\n\n${SQL_INSTRUCTIONS}\n\n${CODE_FENCE}sql\n${testCase.sql.schema.trimEnd()}\n${CODE_FENCE}`;
  }
  if (testCase.graderKind === "unit-test" && testCase.unitTests.editFile !== undefined) {
    return `${user}\n\n${EDIT_FORMAT_INSTRUCTIONS}\n\n${CODE_FENCE}${CODE_LANGUAGE}\n${testCase.unitTests.editFile}${CODE_FENCE}`;
  }
  return user;
}

function buildCaseRequest(testCase: TestCase, target: CaseTarget): CompletionRequest {
  const answerSchema = testCase.graderKind === "schema" ? toStandardJsonSchema(testCase.schema) : undefined;
  const user = userText(testCase, answerSchema);

  const messages: ChatMessage[] = [];
  if (testCase.prompt.system) messages.push({ role: "system", content: testCase.prompt.system });
  messages.push({ role: "user", content: user });
  const tools = testCase.graderKind === "tooltrace" ? testCase.tools : [];

  return {
    model: target.model,
    messages,
    temperature: target.config.temperature ?? undefined,
    providerParameters: generationParameters(
      target.config.harness,
      target.config.providerParameters,
      target.generation,
    ),
    ...(tools.length > 0
      ? {
          tools: tools.map((t) => ({
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            ...(t.parameters ? { parameters: toStandardJsonSchema(t.parameters) } : {}),
          })),
        }
      : {}),
    ...(target.config.nativeJsonSchema && answerSchema
      ? {
          responseFormat: {
            name: testCase.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, RESPONSE_FORMAT_NAME_MAX_LENGTH),
            schema: answerSchema,
          },
        }
      : {}),
  };
}

async function runToolLoop(
  client: CompletionClient,
  responder: CannedResults,
  request: CompletionRequest,
): Promise<CaseExecution> {
  const messages = [...request.messages];
  const toolCalls: ToolCall[] = [];
  const exchange = new Exchange();

  for (let turn = 0; turn < responder.maxTurns; turn++) {
    const completion = await runCompletion(client, { ...request, messages: [...messages] });
    const calls = (completion.toolCalls ?? []).map((call, i) => ({
      ...call,
      id: call.id ?? `${GENERATED_CALL_ID_PREFIX}_${turn}_${i}`,
    }));
    exchange.record(completion, calls);
    if (calls.length === 0) break;
    messages.push(earlierReply(completion.text, calls));
    for (const call of calls) {
      toolCalls.push(call);
      messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(responder.answer(call)) });
    }
  }

  return exchange.execution(toolCalls);
}

/** What a case's replies add up to: usage, reasoning (provider-reported or inline), and every reply's text. */
class Exchange {
  private readonly usage: CompletionUsage = { promptTokens: 0, completionTokens: 0 };
  private readonly replies: string[] = [];
  private reasoning = "";
  private reasoningChars = 0;
  private answerChars = 0;
  private finishReason: string | undefined;
  private model: string | undefined;

  record(completion: Completion, calls: readonly ToolCall[] = []): void {
    const { text, reasoningText } = completion;
    addUsage(this.usage, completion.usage);
    const inlineReasoningChars = reasoningText ? 0 : reasoningTagChars(text);
    this.reasoningChars += reasoningText ? reasoningText.length : inlineReasoningChars;
    this.answerChars += text.length - inlineReasoningChars + callsChars(calls);
    if (reasoningText) this.reasoning += (this.reasoning ? "\n" : "") + reasoningText;
    this.replies.push(text);
    this.finishReason = completion.finishReason;
    this.model = completion.model ?? this.model;
  }

  execution(toolCalls?: ToolCall[]): CaseExecution {
    const { usage } = this;
    return {
      text: this.replies.at(-1) ?? "",
      earlierReplies: this.replies.slice(0, -1),
      ...(toolCalls ? { toolCalls } : {}),
      usage: {
        ...usage,
        reasoningTokens:
          usage.reasoningTokens ?? splitReasoningTokens(usage.completionTokens, this.reasoningChars, this.answerChars),
      },
      finishReason: this.finishReason,
      reasoningText: this.reasoning || undefined,
      model: this.model,
    };
  }
}

function addUsage(total: CompletionUsage, usage: CompletionUsage): void {
  total.promptTokens += usage.promptTokens;
  total.completionTokens += usage.completionTokens;
  if (usage.reasoningTokens !== undefined) total.reasoningTokens = (total.reasoningTokens ?? 0) + usage.reasoningTokens;
}

function callsChars(calls: readonly ToolCall[]): number {
  return calls.reduce((sum, call) => sum + call.name.length + callArguments(call).length, 0);
}

class CannedResults {
  readonly maxTurns: number;
  private readonly entries: CannedToolResult[];
  private readonly spent = new Set<CannedToolResult>();

  constructor(testCase: ToolTraceCase) {
    this.entries = testCase.toolResults ?? [];
    this.maxTurns =
      testCase.toolOptions?.maxTurns ?? Math.max(MIN_TOOL_TURNS, testCase.expectedTools.length + TOOL_TURN_HEADROOM);
  }

  /** The first unspent entry whose name matches and whose args the call contains, else a plain ack. */
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
