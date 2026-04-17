import type { TimelineEntry } from "./timeline-builder.ts";
import { renderTextLines, type TextLine, type TextSegment } from "./render-rich-text.ts";

const ROLE_WIDTH = 10;

export function buildCodexLogLines(timeline: TimelineEntry[], width: number): TextLine[] {
  const lines: TextLine[] = [];
  const wrapWidth = Math.max(20, width - ROLE_WIDTH);
  for (const entry of timeline) {
    if (entry.kind !== "item" || !entry.item) continue;
    const block = renderItem(entry.id, entry.item, wrapWidth);
    if (block.length === 0) continue;
    if (lines.length > 0) lines.push(blankLine(`${entry.id}-gap`));
    lines.push(...block);
  }
  return lines;
}

function renderItem(
  key: string,
  item: {
    id: string;
    type: string;
    status: string;
    text?: string | undefined;
    command?: string | undefined;
    output?: string | undefined;
    exitCode?: number | undefined;
    toolName?: string | undefined;
  },
  wrapWidth: number,
): TextLine[] {
  switch (item.type) {
    case "agentMessage":
      return renderRolePrefixed("assistant", item.text ?? "", key, wrapWidth, { bold: false });
    case "userMessage":
      return renderRolePrefixed("user", item.text ?? "", key, wrapWidth, { bold: false });
    case "reasoning":
      return renderRolePrefixed("reasoning", item.text ?? "", key, wrapWidth, { dimColor: true });
    case "commandExecution":
      return renderCommand(key, item.command ?? "", item.output ?? "", item.exitCode, wrapWidth);
    case "plan":
      return renderRolePrefixed("plan", item.text ?? "", key, wrapWidth, { dimColor: true });
    default:
      return [];
  }
}

function renderRolePrefixed(
  role: string,
  text: string,
  key: string,
  wrapWidth: number,
  textStyle: { bold?: boolean; dimColor?: boolean },
): TextLine[] {
  if (!text.trim()) return [];
  const rolePrefix: TextSegment[] = [{ text: role.padEnd(ROLE_WIDTH, " "), dimColor: true }];
  const emptyPrefix: TextSegment[] = [{ text: "".padEnd(ROLE_WIDTH, " ") }];
  return renderTextLines(text, {
    key,
    width: wrapWidth,
    firstPrefix: rolePrefix,
    continuationPrefix: emptyPrefix,
    style: textStyle,
  });
}

function renderCommand(
  key: string,
  command: string,
  output: string,
  exitCode: number | undefined,
  wrapWidth: number,
): TextLine[] {
  const lines: TextLine[] = [];
  const commandText = command.trim() ? `$ ${command.trim()}` : "$";
  const rolePrefix: TextSegment[] = [{ text: "tool".padEnd(ROLE_WIDTH, " "), dimColor: true }];
  const indentPrefix: TextSegment[] = [{ text: "".padEnd(ROLE_WIDTH, " ") }];
  lines.push(...renderTextLines(commandText, {
    key: `${key}-cmd`,
    width: wrapWidth,
    firstPrefix: rolePrefix,
    continuationPrefix: indentPrefix,
    style: { dimColor: true },
  }));
  const outputTrimmed = output.trim();
  if (outputTrimmed) {
    lines.push(...renderTextLines(outputTrimmed, {
      key: `${key}-out`,
      width: wrapWidth,
      firstPrefix: indentPrefix,
      continuationPrefix: indentPrefix,
      style: { dimColor: true },
    }));
  }
  if (exitCode !== undefined && exitCode !== 0) {
    lines.push(...renderTextLines(`exit ${exitCode}`, {
      key: `${key}-exit`,
      width: wrapWidth,
      firstPrefix: indentPrefix,
      continuationPrefix: indentPrefix,
      style: { color: "red" },
    }));
  }
  return lines;
}

function blankLine(key: string): TextLine {
  return { key, segments: [{ text: "" }] };
}
