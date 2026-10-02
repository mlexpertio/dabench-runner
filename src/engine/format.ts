export const MB_PER_GB = 1024;
const TOKENS_PER_MILLION = 1_000_000;
const PRICE_DECIMALS = 3;
const SHELL_SAFE = /^[a-zA-Z0-9_./:@+-]+$/;

export function formatPerMillion(usdPerToken: number): string {
  return `$${Number((usdPerToken * TOKENS_PER_MILLION).toFixed(PRICE_DECIMALS))}/M`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function shortHash(hash: string, head = 12): string {
  return hash.length <= head ? hash : `${hash.slice(0, head)}…`;
}

export function passedCount(stat: { passRate: number; caseCount: number }): number {
  return Math.round(stat.passRate * stat.caseCount);
}

export function shellQuote(value: string): string {
  return SHELL_SAFE.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}
