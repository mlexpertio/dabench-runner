import { execFile } from "node:child_process";

export type Exec = (cmd: string, args: string[]) => Promise<string>;

const EXEC_TIMEOUT_MS = 5000;

export const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

export function outputLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function sumNumericLines(output: string): number {
  return outputLines(output)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .reduce((sum, n) => sum + n, 0);
}
