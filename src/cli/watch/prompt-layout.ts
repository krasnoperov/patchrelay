import { measureRenderedTextRows } from "./layout-measure.ts";

export const PROMPT_COMPOSER_HINT = "Enter: send  Ctrl-N: newline  Up/Down: history  Esc: cancel";

export function buildPromptComposerDisplayLines(buffer: string, cursor: number): string[] {
  const withCursor = `${buffer.slice(0, cursor)}|${buffer.slice(cursor)}`;
  const contentLines = withCursor.split("\n");

  return [
    ...contentLines.map((line, index) => `${index === 0 ? "prompt> " : "        "}${line}`),
    PROMPT_COMPOSER_HINT,
  ];
}

export function measurePromptComposerRows(buffer: string, cursor: number, width: number): number {
  return buildPromptComposerDisplayLines(buffer, cursor)
    .reduce((count, line) => count + measureRenderedTextRows(line, width), 0);
}
