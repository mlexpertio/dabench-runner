import packageJson from "../../package.json" with { type: "json" };
import type { RunStore } from "../engine/artifact";
import { Harness } from "../engine/harness";
import { ServiceTier } from "../engine/openrouter-endpoints";
import { CliError, fail, flagList, parseArgs, unknownFlags, type Flags } from "./args";
import { cmdExport, ExportFlag, ExportFormat } from "./export";
import { cmdInit, InitFlag } from "./init";
import { unsupportedNodeMessage } from "./invocation";
import { loadEnv } from "./load-env";
import { cmdRun } from "./run";
import { runFlags } from "./run-inputs";
import { cmdValidate, ValidateFlag } from "./validate";

interface HelpNotes {
  init: string;
  storage: string;
}

export interface CliHost {
  command: string;
  store?: RunStore;
  notes: HelpNotes;
}

export const PUBLIC_NOTES: HelpNotes = {
  init: "each run writes an artifact JSON file under artifacts/",
  storage: `Every run writes an artifact JSON file, by default under artifacts/. Pass
--out to choose its path. The CLI updates the file after each case.`,
};

enum Command {
  Init = "init",
  Validate = "validate",
  Run = "run",
  Export = "export",
}

interface CommandSpec {
  flags: (host: CliHost) => readonly string[];
  run: (flags: Flags, host: CliHost) => void | Promise<void>;
}

const COMMANDS: Record<Command, CommandSpec> = {
  [Command.Init]: { flags: () => Object.values(InitFlag), run: cmdInit },
  [Command.Validate]: { flags: () => Object.values(ValidateFlag), run: cmdValidate },
  [Command.Run]: { flags: (host) => runFlags(host.store !== undefined), run: cmdRun },
  [Command.Export]: { flags: () => Object.values(ExportFlag), run: cmdExport },
};

const ARGV_FIRST_ARGUMENT = 2;
const RUN_INDENT_EXTRA = 2;

export function runCli(host: CliHost): void {
  dispatch(host).catch((err: unknown) => {
    if (err instanceof CliError) console.error(`error: ${err.message}`);
    else console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}

async function dispatch(host: CliHost): Promise<void> {
  const unsupported = unsupportedNodeMessage(process.versions.node);
  if (unsupported) fail(unsupported);
  loadEnv();
  const [name, ...rest] = process.argv.slice(ARGV_FIRST_ARGUMENT);
  const command = Object.values(Command).find((known) => known === name);
  if (!command) {
    printUsage(host);
    process.exitCode = name ? 1 : 0;
    return;
  }
  const flags = parseArgs(rest);
  const { flags: known, run } = COMMANDS[command];
  const unknown = unknownFlags(flags, known(host));
  if (unknown.length > 0) fail(`unknown flag ${flagList(unknown)} for ${command}`);
  return run(flags, host);
}

function printUsage({ command, notes }: CliHost): void {
  const runOptions = `${command} run `;
  const indent = " ".repeat(runOptions.length + RUN_INDENT_EXTRA);
  console.error(`${packageJson.name} v${packageJson.version}

Quick start:
  ${command} init [--dir <dir>]
  ${command} validate --suite <suite.json>
  ${command} run --suite <suite.json> --provider <${Object.values(Harness).join("|")}> --model <id>
  ${command} export --artifact <artifact.json> [--format ${Object.values(ExportFormat).join("|")}] > cases.csv

Full options:
  ${runOptions}--config <run.json> | (--suite <s> --provider <p>)
${indent}[--model <id>] [--name <label>]
${indent}[--quant <label>] [--ctx <tokens>] [--temp <temperature>]
${indent}[--endpoint <provider|tag>]
${indent}[--service-tier <${Object.values(ServiceTier).join("|")}>]
${indent}[--params <json> | --params-file <json>] [--out <artifact.json>]

--model picks the model to benchmark (required unless a --config supplies
one); with --config it overrides the file's model, so one config works for
many models.
--name sets the display name recorded with the run.
--quant and --ctx record the run's quantization and context window, overriding
what a local provider reports. --temp sets the sampling temperature (default 0).
With --config, set them in the file instead.
OpenRouter runs pin one serving endpoint with fallbacks off. The CLI picks the
highest disclosed precision that supports tool calls, cheapest first. Use
--endpoint to pick one yourself, by provider (deepinfra) or tag (deepinfra/fp8).
--service-tier selects OpenRouter capacity (default: ${ServiceTier.Default}):
  default    standard capacity and pricing
  flex       lower cost, higher latency and lower availability
  priority   faster capacity at a higher price
  fast       alias for priority
  ultrafast  lowest latency on supported models, at a higher price
The flag overrides service_tier in --params, --params-file or --config.
The CLI pins one endpoint from the selected tier and uses its pricing.
If absent, flex and priority use default; ultrafast tries priority, then default.
An exact --endpoint tag must be compatible with the selected service tier.

${notes.storage}

export prints one row per case (scores, failed checks, tokens, speed, response)
as CSV or JSON lines, ready for pandas, DuckDB or a spreadsheet.
`);
}
