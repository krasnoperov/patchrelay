import { useEffect, useMemo, useReducer } from "react";
import { Box, Text, useStdout } from "ink";
import type { TimelineEntry, TimelineRunInput } from "./timeline-builder.ts";
import type { DetailTab, OperatorFeedEvent, WatchDiffSummary, WatchIssue, WatchIssueContext, WatchTokenUsage } from "./watch-state.ts";
import { HelpBar } from "./HelpBar.tsx";
import { buildDetailLines } from "./detail-rows.ts";
import type { TextLine } from "./render-rich-text.ts";

interface IssueDetailViewProps {
  issue: WatchIssue | undefined;
  timeline: TimelineEntry[];
  follow: boolean;
  scrollOffset: number;
  unreadBelow: number;
  activeRunStartedAt: string | null;
  activeRunId: number | null;
  tokenUsage: WatchTokenUsage | null;
  diffSummary: WatchDiffSummary | null;
  plan: Array<{ step: string; status: string }> | null;
  issueContext: WatchIssueContext | null;
  detailTab: DetailTab;
  rawRuns: TimelineRunInput[];
  rawFeedEvents: OperatorFeedEvent[];
  connected: boolean;
  lastServerMessageAt: number | null;
  reservedRows?: number | undefined;
  onLayoutChange: (viewportRows: number, contentRows: number) => void;
}

export function IssueDetailView({
  issue,
  timeline,
  follow,
  scrollOffset,
  unreadBelow,
  activeRunStartedAt,
  activeRunId,
  tokenUsage,
  diffSummary,
  plan,
  issueContext,
  detailTab,
  rawRuns,
  rawFeedEvents,
  connected,
  lastServerMessageAt,
  reservedRows = 0,
  onLayoutChange,
}: IssueDetailViewProps): React.JSX.Element {
  const [, tick] = useReducer((value: number) => value + 1, 0);
  const { stdout } = useStdout();
  const width = Math.max(20, stdout?.columns ?? 80);
  const totalRows = stdout?.rows ?? 24;
  const footerRows = 1 + (unreadBelow > 0 ? 1 : 0);
  const viewportRows = Math.max(4, totalRows - reservedRows - footerRows);

  useEffect(() => {
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, []);

  const lines = useMemo(() => {
    if (!issue) {
      return [{ key: "loading", segments: [{ text: "Loading issue…", dimColor: true }] }];
    }
    return buildDetailLines({
      issue,
      timeline,
      activeRunStartedAt,
      activeRunId,
      tokenUsage,
      diffSummary,
      plan,
      issueContext,
      detailTab,
      rawRuns,
      rawFeedEvents,
      follow,
      connected,
      lastServerMessageAt,
      width,
    });
  }, [
    issue,
    timeline,
    activeRunStartedAt,
    activeRunId,
    tokenUsage,
    diffSummary,
    plan,
    issueContext,
    detailTab,
    rawRuns,
    rawFeedEvents,
    follow,
    connected,
    lastServerMessageAt,
    width,
  ]);

  useEffect(() => {
    onLayoutChange(viewportRows, lines.length);
  }, [lines.length, onLayoutChange, viewportRows]);

  const maxOffset = Math.max(0, lines.length - viewportRows);
  const start = Math.min(scrollOffset, maxOffset);
  const visibleLines = lines.slice(start, start + viewportRows);
  const fillerCount = Math.max(0, viewportRows - visibleLines.length);

  return (
    <Box flexDirection="column">
      {visibleLines.map((line) => (
        <RenderedLine key={line.key} line={line} />
      ))}
      {Array.from({ length: fillerCount }, (_, index) => (
        <Text key={`detail-fill-${index}`}> </Text>
      ))}
      {unreadBelow > 0 && (
        <Text color="yellow">{`${unreadBelow} below · End jumps back to live`}</Text>
      )}
      <HelpBar view="detail" follow={follow} detailTab={detailTab} />
    </Box>
  );
}

function RenderedLine({ line }: { line: TextLine }): React.JSX.Element {
  if (line.segments.length === 0) {
    return <Text> </Text>;
  }

  return (
    <Text>
      {line.segments.map((segment, index) => (
        <Text
          // eslint-disable-next-line react/no-array-index-key
          key={`${line.key}-${index}`}
          {...(segment.color ? { color: segment.color } : {})}
          {...(segment.dimColor ? { dimColor: true } : {})}
          {...(segment.bold ? { bold: true } : {})}
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}
