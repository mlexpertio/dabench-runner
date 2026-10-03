import { canonicalize } from "./canonical";
import type { ToolCall } from "./client";
import type { ToolStateCase } from "./suite";
import { callMatches } from "./tool-match";

type Environment = ToolStateCase["environment"];
const FINAL_REPLY_TURNS = 1;

export class ToolEnvironment {
  readonly maxTurns: number;
  private state: Environment["initialState"];
  private calls = 0;
  private valid = true;

  constructor(private readonly specification: Environment) {
    this.state = structuredClone(specification.initialState);
    this.maxTurns = specification.maxCalls + FINAL_REPLY_TURNS;
  }

  answer(call: ToolCall): unknown {
    this.calls++;
    const matches = this.specification.actions.filter(
      (action) => callMatches(action, call, "exact") && this.matchesState(action.when ?? {}),
    );
    const malformedArguments = call.argsText !== undefined && call.args === undefined;
    if (malformedArguments || this.calls > this.specification.maxCalls || matches.length !== 1) {
      this.valid = false;
      return { error: "action_not_available" };
    }
    const [action] = matches;
    this.state = { ...this.state, ...structuredClone(action.set ?? {}) };
    return structuredClone(action.result);
  }

  succeeded(): boolean {
    return this.valid && this.matchesState(this.specification.expectedState);
  }

  private matchesState(expected: Environment["initialState"]): boolean {
    return Object.entries(expected).every(
      ([key, value]) => Object.hasOwn(this.state, key) && canonicalize(value) === canonicalize(this.state[key]),
    );
  }
}
