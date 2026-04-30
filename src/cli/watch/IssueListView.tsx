import { useEffect, useReducer } from "react";
import { Box, Text, useStdout } from "ink";
import type { WatchFilter, WatchIssue } from "./watch-state.ts";
import { IssueRow } from "./IssueRow.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { HelpBar } from "./HelpBar.tsx";
import { computeIssueListLayout, computeVisibleIssueParts, computeVisibleWindowForTotal } from "./list-layout.ts";

interface IssueListViewProps {
  issues: WatchIssue[];
  selectedIndex: number;
  connected: boolean;
  lastServerMessageAt: number | null;
  filter: WatchFilter;
  frozen?: boolean | undefined;
  compact?: boolean | undefined;
}

export function computeVisibleWindow(
  issues: WatchIssue[],
  selectedIndex: number,
  maxRows: number,
): { start: number; end: number } {
  return computeVisibleWindowForTotal(issues.length, selectedIndex, maxRows);
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
  const rows = Math.max(1, stdout?.rows ?? 24);
  const titleWidth = Math.max(0, cols - 42);
  const layout = computeIssueListLayout(rows);

  const [, tick] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    if (frozen) return;
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [frozen]);

  const {
    start: startIndex,
    end: endIndex,
    showAbove,
    showBelow,
  } = computeVisibleIssueParts(issues.length, selectedIndex, layout.bodyRows);
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
      <Box marginTop={layout.showBodyGap ? 1 : 0} flexDirection="column">
        {issues.length === 0 ? (
          <Text dimColor> </Text>
        ) : (
          <>
            {showAbove ? <Text dimColor>{`  ↑${hiddenAbove}`}</Text> : null}
            {visible.map((issue, i) => (
              <IssueRow
                key={issue.issueKey ?? `${issue.projectId}-${startIndex + i}`}
                issue={issue}
                selected={startIndex + i === selectedIndex}
                titleWidth={titleWidth}
                compact={compact}
              />
            ))}
            {showBelow ? <Text dimColor>{`  ↓${hiddenBelow}`}</Text> : null}
          </>
        )}
      </Box>
      {layout.showHelp ? (
        <Box marginTop={1}>
          <HelpBar view="list" />
        </Box>
      ) : null}
    </Box>
  );
}
