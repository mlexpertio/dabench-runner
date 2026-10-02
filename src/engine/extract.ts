type JsonExtract = { ok: true; value: unknown } | { ok: false; error: string };

const JSON_FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

/** The JSON inside an answer that isn't a bare JSON value: its first fenced block, else its first balanced value. */
export function extractEmbeddedJson(output: string): JsonExtract {
  const text = output.trim();
  for (const candidate of [text.match(JSON_FENCE)?.[1].trim(), firstBalanced(text)]) {
    if (!candidate) continue;
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {}
  }
  return { ok: false, error: "output does not contain parseable JSON" };
}

const FENCED_BLOCK = /```[^\n`]*\r?\n([\s\S]*?)```/gu;

/** The contents of each fenced block, whatever language the fence names. */
export function fencedBlocks(output: string): string[] {
  return [...output.matchAll(FENCED_BLOCK)].map((match) => match[1]);
}

export function extractCode(output: string): string {
  return (fencedBlocks(output)[0] ?? output).trim();
}

function firstBalanced(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start === -1) return null;

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
