import { useEffect, useMemo } from "react";
import { Box, Text, useStdout } from "ink";
import type { TimelineEntry } from "./timeline-builder.ts";
import type { WatchIssue } from "./watch-state.ts";
import { HelpBar } from "./HelpBar.tsx";
import { buildCodexLogLines } from "./codex-log-rows.ts";
import { renderTextLines, type TextLine, type TextSegment } from "./render-rich-text.ts";
import { issueTokenFor, prTokenFor } from "./issue-token.ts";

interface LogViewProps {
  issue: WatchIssue | undefined;
  timeline: TimelineEntry[];
  follow: boolean;
  scrollOffset: number;
  activeRunId: number | null;
  reservedRows?: number | undefined;
  onLayoutChange: (viewportRows: number, contentRows: number) => void;
}

export function LogView({
  issue,
  timeline,
  follow,
  scrollOffset,
  activeRunId,
  reservedRows = 0,
  onLayoutChange,
}: LogViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const width = Math.max(20, stdout?.columns ?? 80);
  const totalRows = stdout?.rows ?? 24;
  const viewportRows = Math.max(4, totalRows - reservedRows - 2);

  const lines = useMemo(() => {
    if (!issue) {
      return [{ key: "loading", segments: [{ text: "Loading issue…", dimColor: true }] }];
    }
    const headerLines = buildLogHeader(issue, activeRunId, width);
    const bodyLines = buildCodexLogLines(timeline, width);
    if (bodyLines.length === 0) {
      return [
        ...headerLines,
        blankLine("header-gap"),
        ...renderTextLines("No app-server output yet.", { key: "empty", width, style: { dimColor: true } }),
      ];
    }
    return [...headerLines, blankLine("header-gap"), ...bodyLines];
  }, [activeRunId, issue, timeline, width]);

  useEffect(() => {
    onLayoutChange(viewportRows, lines.length);
  }, [viewportRows, lines.length, onLayoutChange]);

  const startIndex = clamp(scrollOffset, 0, Math.max(0, lines.length - viewportRows));
  const visible = lines.slice(startIndex, startIndex + viewportRows);

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {visible.map((line) => (
          <Box key={line.key}>
            {line.segments.map((segment, index) => {
              const props: { dimColor?: boolean; bold?: boolean; color?: string } = {};
              if (segment.dimColor) props.dimColor = true;
              if (segment.bold) props.bold = true;
              if (segment.color) props.color = segment.color;
              return (
                <Text key={`${line.key}-${index}`} {...props}>
                  {segment.text}
                </Text>
              );
            })}
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <HelpBar view="log" follow={follow} />
      </Box>
    </Box>
  );
}

function buildLogHeader(issue: WatchIssue, activeRunId: number | null, width: number): TextLine[] {
  const token = issueTokenFor(issue);
  const pr = prTokenFor(issue);
  const key = issue.issueKey ?? issue.projectId;
  const segments: TextSegment[] = [
    { text: key, color: token.color, bold: true },
    { text: "  " },
    { text: token.glyph, color: token.color },
    { text: "  " },
    { text: token.phrase },
  ];
  if (pr) {
    segments.push({ text: "   " });
    segments.push({ text: `#${pr.prNumber} ${pr.glyph}`, color: pr.color });
  }
  if (activeRunId !== null) {
    segments.push({ text: "   " });
    segments.push({ text: `run #${activeRunId}`, dimColor: true });
  }
  const plain = renderTextLines(segments.map((s) => s.text).join(""), { key: "log-header", width });
  if (plain.length > 0) {
    plain[0] = { key: plain[0]!.key, segments };
  }
  return plain;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function blankLine(key: string): TextLine {
  return { key, segments: [{ text: "" }] };
}
