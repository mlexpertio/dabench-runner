# DaBench runner

DaBench runner benchmarks an LLM on a suite of test cases and grades every answer with code, not with a judge model. It checks exact answers, JSON against a schema, tool-call sequences, unit tests, SQL query results and rubric patterns. It works with any OpenAI-compatible endpoint: OpenRouter, OpenAI, Ollama, vLLM and llama.cpp.

It needs Node.js 24.10 or newer.

## Quick start

```sh
npx dabench init
npx dabench validate --suite mybench/suite.json
OPENROUTER_API_KEY=your-key npx dabench run --suite mybench/suite.json --provider openrouter --model qwen/qwen-2.5-7b-instruct
```

`init` copies the public sample suite to `mybench/suite.json`. It has 14 cases, two from each of the seven DaBench categories.

`run` writes `artifacts/<run-id>.artifact.json` and updates it after each case. Pass `--out path/to/result.json` to choose the file. The CLI reads `OPENROUTER_API_KEY` or `OPENAI_API_KEY` from the environment, or from a `.env` or `.env.local` file in the current directory.

Local servers need no key. The CLI expects Ollama on port 11434, vLLM on 8000 and llama.cpp on 8080:

```sh
npx dabench run --suite mybench/suite.json --provider ollama --model qwen3:8b
```

Run `npx dabench` to see every option.

## OpenRouter service tiers

Choose a service tier with `--service-tier`. OpenRouter runs use `default` when no tier is supplied.

```sh
npx dabench run --suite mybench/suite.json --provider openrouter --model openai/gpt-5 --service-tier flex
```

| Tier        | Capacity                                               |
| ----------- | ------------------------------------------------------ |
| `default`   | Standard capacity and pricing.                         |
| `flex`      | Lower cost, higher latency and lower availability.     |
| `priority`  | Faster capacity at a higher price.                     |
| `fast`      | Alias for `priority`.                                  |
| `ultrafast` | Lowest latency on supported models, at a higher price. |

The flag works with `--provider openrouter` and OpenRouter `--config` files. It overrides `service_tier` in `--params`, `--params-file`, or `config.providerParameters`. Those JSON settings still work when the flag is omitted. Invalid tiers and use of the flag with another provider fail before the benchmark starts.

The runner selects the requested tier before comparing endpoint precision, health and price. `--endpoint openai` restricts selection to that provider. Exact endpoint tags must be compatible with the tier, for example `--service-tier flex --endpoint openai/flex`. The `openai/fast` and `openai/priority` tags are interchangeable.

If a tier is absent, `priority` uses standard capacity, and `ultrafast` tries priority before standard. Flex uses standard capacity only when the model has no flex endpoints at all. These choices follow [OpenRouter's service-tier behavior](https://openrouter.ai/docs/guides/features/service-tiers). The runner then pins one endpoint with fallbacks disabled and records its pricing. Request failures do not switch to another endpoint.

## Results as CSV or JSON lines

```sh
npx dabench export --artifact artifacts/<run-id>.artifact.json > cases.csv
npx dabench export --artifact artifacts/<run-id>.artifact.json --format jsonl > cases.jsonl
```

Each row is one case: run id, model, case id, category, grader, pass/fail, score, failed checks, finish reason, token counts, tokens per second, latency, tool calls, the response and the reasoning. CSV cells that hold lists are JSON-encoded. Export several runs and concatenate them to compare models.

```python
import pandas as pd

cases = pd.read_csv("cases.csv")
cases.groupby("category")["passed"].mean()
```

## Write your own suite

A suite is one JSON file. It has an `id`, a `version`, the `categories` in display order, and the `cases`. Each case names its category, a difficulty tier from 1 to 3, a prompt (`user`, plus an optional `system`) and a `graderKind` with what that grader checks:

| `graderKind` | Passes when the answer                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `exact`      | equals the expected text                                                                        |
| `json-match` | is JSON equal to the expected value                                                             |
| `schema`     | is JSON that validates against a JSON Schema                                                    |
| `tooltrace`  | makes the expected tool calls, in order, with the expected arguments                            |
| `tool-state` | reaches the expected simulated state within a call budget without invalid or forbidden actions  |
| `unit-test`  | is JavaScript that passes the case's tests, run in a sandboxed Node.js process                  |
| `rubric`     | passes every required text check, such as contains, does not contain, a regex or a length limit |
| `sql`        | is a SQLite query that returns the expected rows from a seeded database                         |

[`src/engine/suite.ts`](src/engine/suite.ts) defines every field. Edit the file `init` writes and run `validate` after each change. Any language can write the file, for example Python's `json.dump`. The CLI only reads suites as JSON and never runs them as code.

A `tool-state` case declares tools and an `environment` with `initialState`, `actions`, `expectedState` and `maxCalls`. Each action has a tool name, exact arguments, a fixed result, optional `when` conditions and optional `set` updates. Conditions compare entire values at the named top-level state keys; updates replace those keys. Exactly one action must match a call and the current state. Unknown, ambiguous or over-budget actions return `action_not_available` and fail the case. Grading replays the calls and checks the terminal state, forbidden calls and final reply. The model sees tool interfaces and results, never the hidden state or action rules. State-based tasks allow at most 31 calls plus a final reply turn.

A JSON conversation may set `jsonMatch.expectedTurns` to the expected replies before the final answer. Its length must equal `prompt.turns.length`; `jsonMatch.expected` still checks the final reply. Correctness is the mean of the per-reply correctness values, and format quality is the lowest per-reply quality. Cases without checkpoints retain final-answer grading.

The sample ([`suites/sample.suite.json`](suites/sample.suite.json)) shows what each DaBench category tests. DaBench board scores come from a separate private suite.

## Development

`npm run engine -- <command>` runs the CLI from source. Run `npm test`, `npm run typecheck`, `npm run lint` and `npm run format:check` before publishing changes.

## License

[MIT](LICENSE).
