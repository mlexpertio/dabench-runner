import { fileURLToPath } from "node:url";
import { errorMessage } from "./guards";
import { Sandbox, type SandboxOptions } from "./sandbox";
import type { UnitTestSpec } from "./suite";

const SANDBOX_START_TIMEOUT_MS = 5000;
const TEST_TIMEOUT_MS = 1000;
const BLOCKED_SANDBOX_TIMEOUT_MS = 2 * TEST_TIMEOUT_MS;
const HEAP_MB = 1024;

const SANDBOX: SandboxOptions = {
  script: fileURLToPath(new URL("./js-sandbox.mjs", import.meta.url)),
  label: "JavaScript sandbox",
  args: [String(TEST_TIMEOUT_MS)],
  heapMb: HEAP_MB,
};

type SandboxRequest =
  { kind: "compile"; code: string } | { kind: "call"; setup?: string; code: string; entry: string; argsJson: string };

type TestOutcome = { ok: true; value: unknown } | { ok: false; error: string };

interface CodeTestRun {
  compileError?: string;
  outcomes: TestOutcome[];
}

export async function runCodeTests(spec: UnitTestSpec, code: string): Promise<CodeTestRun> {
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await start();
    const compiled = await request(sandbox, { kind: "compile", code });
    if (!compiled.ok) return { compileError: compiled.error, outcomes: [] };

    const outcomes: TestOutcome[] = [];
    for (const testCase of spec.cases) {
      try {
        sandbox ??= await start();
        outcomes.push(
          await request(sandbox, {
            kind: "call",
            setup: spec.setup,
            code,
            entry: spec.entry,
            argsJson: JSON.stringify(testCase.args),
          }),
        );
      } catch (err) {
        outcomes.push({ ok: false, error: errorMessage(err) });
        sandbox?.stop();
        sandbox = undefined;
      }
    }
    return { outcomes };
  } catch (err) {
    return { compileError: errorMessage(err), outcomes: [] };
  } finally {
    sandbox?.stop();
  }
}

async function start(): Promise<Sandbox> {
  const sandbox = Sandbox.fork(SANDBOX);
  try {
    await sandbox.nextMessage(SANDBOX_START_TIMEOUT_MS, `the ${SANDBOX.label} did not start`);
    return sandbox;
  } catch (err) {
    sandbox.stop();
    throw err;
  }
}

function request(sandbox: Sandbox, message: SandboxRequest): Promise<TestOutcome> {
  return sandbox.request(message, BLOCKED_SANDBOX_TIMEOUT_MS, `timed out after ${BLOCKED_SANDBOX_TIMEOUT_MS}ms`);
}
