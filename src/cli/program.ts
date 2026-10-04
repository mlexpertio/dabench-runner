import { ENGINE_VERSION } from "../engine/schema";
import { ServiceTier } from "../engine/service-tier";
import { CliError, fail, flagList, parseArgs, unknownFlags } from "./args";
import { cmdExport, ExportFlag, ExportFormat } from "./export";
import { cmdInit, InitFlag } from "./init";
import { unsupportedNodeMessage } from "./invocation";
import { loadEnv } from "./load-env";
import { PROVIDER_NAMES } from "./providers";
import { cmdRun } from "./run";
import { RUN_FLAGS } from "./run-inputs";
import type { RunStore } from "./run-store";
import { cmdValidate, ValidateFlag } from "./validate";

/** The help and init sentences that depend on where a CLI records its runs. */
interface HelpNotes {
  init: string;
  name: string;
  scope: string;
  storage: string;
}

export interface CliHost {
  command: string;
  store?: RunStore;
  notes: HelpNotes;
}

export const PUBLIC_NOTES: HelpNotes = {
  init: "each run writes an artifact JSON file under artifacts/",
  name: "--name sets the display name recorded in the artifact.",
  scope: `--category limits execution to one or more comma-separated suite categories.
--subset quant-impact marks a full local-model run as a footprint build.`,
  storage: `Every run writes an artifact JSON file, by default under artifacts/. Pass
--out to choose its path. The CLI updates the file after each case. The public
CLI starts a new run each time; --fresh only applies to the DaBench app's
database CLI.`,
};

enum Command {
  Init = "init",
  Validate = "validate",
  Run = "run",
  Export = "export",
}

const COMMAND_FLAGS: Record<Command, readonly string[]> = {
  [Command.Init]: Object.values(InitFlag),
  [Command.Validate]: Object.values(ValidateFlag),
  [Command.Run]: RUN_FLAGS,
  [Command.Export]: Object.values(ExportFlag),
};

const COMMANDS: readonly string[] = Object.values(Command);
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
  const [command, ...rest] = process.argv.slice(ARGV_FIRST_ARGUMENT);
  if (!isCommand(command)) {
    printUsage(host);
    process.exitCode = command ? 1 : 0;
    return;
  }
  const flags = parseArgs(rest);
  const unknown = unknownFlags(flags, COMMAND_FLAGS[command]);
  if (unknown.length > 0) fail(`unknown flag ${flagList(unknown)} for ${command}`);

  switch (command) {
    case Command.Init:
      return cmdInit(flags, host);
    case Command.Validate:
      return cmdValidate(flags);
    case Command.Run:
      return cmdRun(flags, host);
    case Command.Export:
      return cmdExport(flags);
  }
}

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && COMMANDS.includes(value);
}

function printUsage({ command, notes }: CliHost): void {
  const runOptions = `${command} run `;
  const indent = " ".repeat(runOptions.length + RUN_INDENT_EXTRA);
  console.error(`DaBench engine v${ENGINE_VERSION}

Quick start:
  ${command} init [--dir <dir>]
  ${command} validate --suite <suite.json>
  ${command} run --suite <suite.json> --provider <${PROVIDER_NAMES.join("|")}> --model <id>
  ${command} export --artifact <artifact.json> [--format ${Object.values(ExportFormat).join("|")}] > cases.csv

Full options:
  ${runOptions}--config <run.json> | (--suite <s> --provider <p>)
${indent}[--model <id>] [--name <label>]
${indent}[--quant <label>] [--ctx <tokens>] [--temp <temperature>]
${indent}[--category <slug[,slug...]> | --subset quant-impact]
${indent}[--endpoint <provider|tag>]
${indent}[--service-tier <${Object.values(ServiceTier).join("|")}>]
${indent}[--params <json> | --params-file <json>] [--out <artifact.json>]
${indent}[--fresh] [--native-json]

--model picks the model to benchmark (required unless a --config supplies
one); with --config it overrides the file's model, so one config works for
many models.
${notes.name}
--quant and --ctx record the run's quantization and context window, overriding
what a local provider reports. --temp sets the sampling temperature (default 0).
With --config, set them in the file instead.
${notes.scope}
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
