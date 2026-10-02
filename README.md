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
| `unit-test`  | is JavaScript that passes the case's tests, run in a sandboxed Node.js process                  |
| `rubric`     | passes every required text check, such as contains, does not contain, a regex or a length limit |
| `sql`        | is a SQLite query that returns the expected rows from a seeded database                         |

[`src/engine/suite.ts`](src/engine/suite.ts) defines every field. Edit the file `init` writes and run `validate` after each change. Any language can write the file, for example Python's `json.dump`. The CLI only reads suites as JSON and never runs them as code.

The sample ([`suites/sample.suite.json`](suites/sample.suite.json)) shows what each DaBench category tests. DaBench board scores come from a separate private suite.

## Development

`npm run engine -- <command>` runs the CLI from source. Run `npm test`, `npm run typecheck`, `npm run lint` and `npm run format:check` before publishing changes.

## License

[MIT](LICENSE).
