import { useEffect, useReducer } from "react";
import { Box, Text, useStdout } from "ink";
import type { WatchFilter, WatchIssue } from "./watch-state.ts";
import { IssueRow } from "./IssueRow.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { HelpBar } from "./HelpBar.tsx";

interface IssueListViewProps {
  issues: WatchIssue[];
  selectedIndex: number;
  connected: boolean;
  lastServerMessageAt: number | null;
  filter: WatchFilter;
  frozen?: boolean | undefined;
  compact?: boolean | undefined;
}

const CHROME_ROWS = 3;

export function computeVisibleWindow(
  issues: WatchIssue[],
  selectedIndex: number,
  maxRows: number,
): { start: number; end: number } {
  if (issues.length === 0) return { start: 0, end: 0 };
  const clamped = Math.max(0, Math.min(selectedIndex, issues.length - 1));
  const half = Math.floor(maxRows / 2);
  let start = Math.max(0, clamped - half);
  let end = Math.min(issues.length, start + maxRows);
  if (end - start < maxRows) {
    start = Math.max(0, end - maxRows);
  }
  return { start, end };
}

export function IssueListView({
  issues,
  selectedIndex,
  connected,
  lastServerMessageAt,
  filter,
  frozen,
  compact = false,
}: IssueListViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const titleWidth = Math.max(0, cols - 42);
  const maxVisibleRows = Math.max(1, rows - CHROME_ROWS);

  const [, tick] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    if (frozen) return;
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [frozen]);

  const { start: startIndex, end: endIndex } = computeVisibleWindow(issues, selectedIndex, maxVisibleRows);
  const visible = issues.slice(startIndex, endIndex);
  const hiddenAbove = startIndex;
  const hiddenBelow = Math.max(0, issues.length - endIndex);

  return (
    <Box flexDirection="column">
      <StatusBar
        filter={filter}
        connected={connected}
        lastServerMessageAt={lastServerMessageAt}
        frozen={frozen ?? false}
      />
      <Box marginTop={1} flexDirection="column">
        {issues.length === 0 ? (
          <Text dimColor> </Text>
        ) : (
          <>
            {hiddenAbove > 0 ? <Text dimColor>{`  ↑${hiddenAbove}`}</Text> : null}
            {visible.map((issue, i) => (
              <IssueRow
                key={issue.issueKey ?? `${issue.projectId}-${startIndex + i}`}
                issue={issue}
                selected={startIndex + i === selectedIndex}
                titleWidth={titleWidth}
                compact={compact}
              />
            ))}
            {hiddenBelow > 0 ? <Text dimColor>{`  ↓${hiddenBelow}`}</Text> : null}
          </>
        )}
      </Box>
      <Box marginTop={1}>
        <HelpBar view="list" />
      </Box>
    </Box>
  );
}
