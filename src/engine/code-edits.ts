const EDIT_BLOCK = /^<{7} SEARCH\r?\n([\s\S]*?)^={7}\r?\n([\s\S]*?)^>{7} REPLACE[ \t]*$/gmu;

export const EDIT_FORMAT_INSTRUCTIONS = `Reply with SEARCH/REPLACE blocks that edit the file below, not the whole file. Each block looks like this:

<<<<<<< SEARCH
lines copied exactly from the current file
=======
the lines that replace them
>>>>>>> REPLACE

Each SEARCH part must match exactly one place in the file, including indentation. Blocks apply in order, each to the file as the earlier blocks left it.`;

type EditResult = { ok: true; code: string } | { ok: false; error: string };

function lf(text: string): string {
  return text.replace(/\r\n/gu, "\n");
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count++;
  return count;
}

export function applyEditBlocks(file: string, answer: string): EditResult {
  const blocks = [...lf(answer).matchAll(EDIT_BLOCK)];
  if (blocks.length === 0) return { ok: false, error: "no SEARCH/REPLACE blocks in the answer" };
  let code = lf(file);
  for (const [index, [, search, replace]] of blocks.entries()) {
    const label = `block ${index + 1}`;
    if (search.trim() === "") return { ok: false, error: `${label}: the SEARCH part is empty` };
    const matches = occurrences(code, search);
    if (matches === 0) return { ok: false, error: `${label}: the SEARCH text is not in the file` };
    if (matches > 1) return { ok: false, error: `${label}: the SEARCH text matches ${matches} places` };
    code = code.replace(search, () => replace);
  }
  return { ok: true, code };
}
