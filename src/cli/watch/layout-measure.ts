import { renderTextLines } from "./render-rich-text.ts";

export function measureRenderedTextRows(text: string, width: number): number {
  return renderTextLines(text, {
    key: "measure",
    width,
  }).length;
}
