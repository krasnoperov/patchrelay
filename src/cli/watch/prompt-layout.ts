import { measureRenderedTextRows } from "./layout-measure.ts";

export function buildPromptComposerDisplayLines(buffer: string, cursor: number): string[] {
  const withCursor = `${buffer.slice(0, cursor)}|${buffer.slice(cursor)}`;
  const contentLines = withCursor.split("\n");

  return [
    ...contentLines.map((line, index) => `${index === 0 ? "prompt> " : "        "}${line}`),
    "Enter: newline  Ctrl-S: send  Up/Down: history  Esc: cancel",
  ];
}

export function measurePromptComposerRows(buffer: string, cursor: number, width: number): number {
  return buildPromptComposerDisplayLines(buffer, cursor)
    .reduce((count, line) => count + measureRenderedTextRows(line, width), 0);
}
