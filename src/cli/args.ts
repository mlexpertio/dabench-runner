import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { errorMessage } from "../engine/guards";

export type Flags = Record<string, string | boolean>;

const FLAG_PREFIX = "--";

export function parseArgs(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith(FLAG_PREFIX)) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(FLAG_PREFIX.length, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith(FLAG_PREFIX)) {
        flags[arg.slice(FLAG_PREFIX.length)] = next;
        i++;
      } else {
        flags[arg.slice(FLAG_PREFIX.length)] = true;
      }
    }
  }
  return flags;
}

export function unknownFlags(flags: Flags, known: readonly string[]): string[] {
  return Object.keys(flags).filter((name) => !known.includes(name));
}

export function flagList(names: readonly string[]): string {
  return names.map((name) => `${FLAG_PREFIX}${name}`).join(", ");
}

export function requireFlag(flags: Flags, name: string): string {
  const value = stringFlag(flags, name);
  if (!value) fail(`missing required --${name}`);
  return value;
}

export function stringFlag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  if (value === true) fail(`--${name} needs a value`);
  return typeof value === "string" && value ? value : undefined;
}

export function numberFlag(flags: Flags, name: string): number | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  const number = typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 0) fail(`--${name} must be a non-negative number`);
  return number;
}

export function booleanFlag(flags: Flags, name: string): boolean {
  const value = flags[name];
  if (typeof value === "string") fail(`--${name} takes no value`);
  return value === true;
}

export function readJsonFile(path: string, unreadable = `could not read JSON at ${path}`): unknown {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (err) {
    fail(`${unreadable}: ${errorMessage(err)}`);
  }
}

export function parseInput<T extends z.ZodType>(schema: T, value: unknown, source: string): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail(`${source}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** A mistake in how the CLI was invoked or configured, reported as one line without a stack trace. */
export class CliError extends Error {}

export function fail(message: string): never {
  throw new CliError(message);
}
