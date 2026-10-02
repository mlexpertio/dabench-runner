import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { booleanFlag, fail, stringFlag, type Flags } from "./args";
import type { CliHost } from "./program";

export enum InitFlag {
  Dir = "dir",
  Force = "force",
}

const DEFAULT_INIT_DIR = "mybench";
const SUITE_FILE = "suite.json";
const SAMPLE_SUITE = fileURLToPath(new URL("../../suites/sample.suite.json", import.meta.url));

export function cmdInit(flags: Flags, { command, notes }: CliHost): void {
  const dir = stringFlag(flags, InitFlag.Dir) ?? DEFAULT_INIT_DIR;
  const suitePath = resolve(dir, SUITE_FILE);
  if (existsSync(suitePath) && !booleanFlag(flags, InitFlag.Force)) {
    fail(`${relative(process.cwd(), suitePath)} already exists (pass --${InitFlag.Force} to overwrite)`);
  }

  mkdirSync(dirname(suitePath), { recursive: true });
  copyFileSync(SAMPLE_SUITE, suitePath);

  console.error(`✓ wrote ${relative(process.cwd(), suitePath)} (the public sample suite, ready to edit)`);
  console.error("\nNext:");
  console.error(`  ${command} validate --suite ${dir}/${SUITE_FILE}`);
  console.error(
    `  ${command} run --suite ${dir}/${SUITE_FILE} --provider openrouter --model qwen/qwen-2.5-7b-instruct`,
  );
  console.error(`  ${notes.init}`);
}
