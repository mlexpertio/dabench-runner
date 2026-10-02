const REASONING_TAGS = "think|thinking|reasoning";
const CLOSED_BLOCK = new RegExp(`<(${REASONING_TAGS})>([\\s\\S]*?)</\\1>`, "gi");
const OPEN_TAG = new RegExp(`<(?:${REASONING_TAGS})>`, "i");

export function stripReasoning(output: string): string {
  const closed = output.replace(CLOSED_BLOCK, "");
  const dangling = closed.search(OPEN_TAG);
  return (dangling === -1 ? closed : closed.slice(0, dangling)).trim();
}

export function reasoningTagChars(text: string): number {
  let chars = 0;
  const rest = text.replace(CLOSED_BLOCK, (_block, _tag, body: string) => {
    chars += body.length;
    return "";
  });
  const dangling = OPEN_TAG.exec(rest);
  if (dangling) chars += rest.length - dangling.index - dangling[0].length;
  return chars;
}
