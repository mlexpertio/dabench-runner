import { MS_PER_SECOND } from "../engine/calc";
import { pluralize } from "../engine/format";
import type { RetryOptions } from "../engine/openai-client";
import type { RunObserver } from "../engine/runner";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const IS_TTY = process.stderr.isTTY === true;
const CLEAR = IS_TTY ? "\r\x1b[2K" : "";
const THOUSAND_TOKENS = 1000;

function progressWrite(text: string): void {
  process.stderr.write(`${CLEAR}${text}`);
}

export const reportRetry: RetryOptions["onRetry"] = ({ retriesLeft, delayMs, status, message }) => {
  const code = status ? `${status}` : "network";
  const wait = (delayMs / MS_PER_SECOND).toFixed(1);
  progressWrite(`    ⏳ ${code}: waiting ${wait}s, ${pluralize(retriesLeft, "retry", "retries")} left (${message})\n`);
};

export function createProgressReporter(): Required<RunObserver> {
  let spin = 0;
  const tag = (index: number, total: number) => `[${String(index).padStart(String(total).length)}/${total}]`;
  return {
    onCaseStart: ({ index, total, caseId, category }) => {
      if (!IS_TTY) return;
      progressWrite(` ${SPINNER[0]} ${tag(index, total)} ${category}/${caseId} · starting…`);
    },
    onCaseTick: ({ index, total, caseId, category, phase, reasoningTokens, contentTokens, elapsedMs }) => {
      if (!IS_TTY) return;
      const frame = SPINNER[spin++ % SPINNER.length];
      const verb = phase === "thinking" ? "thinking" : "writing";
      const tok = phase === "thinking" ? reasoningTokens : contentTokens;
      progressWrite(
        ` ${frame} ${tag(index, total)} ${category}/${caseId} · ${verb} ${formatTokens(tok)} tok · ${Math.round(elapsedMs / MS_PER_SECOND)}s`,
      );
    },
    onCaseError: ({ index, total, caseId, category, message }) => {
      progressWrite(`    ⚠ ${tag(index, total)} ${category}/${caseId} errored, scored 0, continuing (${message})\n`);
    },
    onProgress: ({ index, total, caseId, category, score, elapsedMs }) => {
      const line = `  ${tag(index, total)} ${String(score).padStart(3)}/100  ${category}/${caseId} · ${(elapsedMs / MS_PER_SECOND).toFixed(1)}s`;
      if (IS_TTY) progressWrite(`${line}\n`);
      else console.error(line);
    },
  };
}

function formatTokens(n: number): string {
  return n >= THOUSAND_TOKENS ? `${(n / THOUSAND_TOKENS).toFixed(1)}k` : `${n}`;
}
