import { useEffect, useReducer } from "react";
import { Box, Text, useStdout } from "ink";
import type { WatchFilter, WatchIssue } from "./watch-state.ts";
import { IssueRow, estimateIssueRowHeight } from "./IssueRow.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { HelpBar } from "./HelpBar.tsx";

interface IssueListViewProps {
  issues: WatchIssue[];
  allIssues: WatchIssue[];
  selectedIndex: number;
  connected: boolean;
  lastServerMessageAt: number | null;
  filter: WatchFilter;
  totalCount: number;
  frozen?: boolean | undefined;
}

const FIXED_COLS = 8;
const CHROME_ROWS = 4;

export function computeVisibleWindow(
  issues: WatchIssue[],
  selectedIndex: number,
  maxRows: number,
  cols: number,
  titleWidth: number,
): { start: number; end: number } {
  if (issues.length === 0) return { start: 0, end: 0 };

  const clampedSelected = Math.max(0, Math.min(selectedIndex, issues.length - 1));
  const heights = issues.map((issue, index) => estimateIssueRowHeight(issue, index === clampedSelected, cols, titleWidth));
  let start = clampedSelected;
  let end = clampedSelected + 1;
  let usedRows = heights[clampedSelected] ?? 1;

  while (true) {
    const canAddAbove = start > 0 && usedRows + (heights[start - 1] ?? 1) <= maxRows;
    const canAddBelow = end < issues.length && usedRows + (heights[end] ?? 1) <= maxRows;
    if (!canAddAbove && !canAddBelow) break;

    const aboveDistance = clampedSelected - start;
    const belowDistance = end - 1 - clampedSelected;
    const preferAbove = canAddAbove && (!canAddBelow || aboveDistance <= belowDistance);

    if (preferAbove) {
      start -= 1;
      usedRows += heights[start] ?? 1;
      continue;
    }

    if (canAddBelow) {
      usedRows += heights[end] ?? 1;
      end += 1;
    }
  }

  return { start, end };
}

export function IssueListView({
  issues,
  allIssues,
  selectedIndex,
  connected,
  lastServerMessageAt,
  filter,
  totalCount,
  frozen,
}: IssueListViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const titleWidth = Math.max(0, cols - FIXED_COLS);
  const maxVisibleRows = Math.max(1, rows - CHROME_ROWS);

  // Periodic refresh for elapsed times
  const [, tick] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    if (frozen) return;
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [frozen]);

  const { start: startIndex, end: endIndex } = computeVisibleWindow(issues, selectedIndex, maxVisibleRows, cols, titleWidth);
  const visible = issues.slice(startIndex, endIndex);
  const hiddenAbove = startIndex;
  const hiddenBelow = Math.max(0, issues.length - endIndex);

  return (
    <Box flexDirection="column">
      <StatusBar
        issues={issues}
        totalCount={totalCount}
        filter={filter}
        connected={connected}
        lastServerMessageAt={lastServerMessageAt}
        allIssues={allIssues}
        frozen={frozen ?? false}
      />
      <Box marginTop={1} flexDirection="column">
        {issues.length === 0 ? (
          <Text dimColor>No issues match the current filter.</Text>
        ) : (
          <>
            {hiddenAbove > 0 && <Text dimColor>  {hiddenAbove} more above</Text>}
            {visible.map((issue, i) => (
              <IssueRow
                key={issue.issueKey ?? `${issue.projectId}-${startIndex + i}`}
                issue={issue}
                selected={startIndex + i === selectedIndex}
                titleWidth={titleWidth}
              />
            ))}
            {hiddenBelow > 0 && <Text dimColor>  {hiddenBelow} more below</Text>}
          </>
        )}
      </Box>
      <Box marginTop={1}>
        <HelpBar view="list" />
      </Box>
    </Box>
  );
}
