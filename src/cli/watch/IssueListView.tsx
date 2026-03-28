import { useEffect, useReducer } from "react";
import { Box, Text, useStdout } from "ink";
import type { WatchFilter, WatchIssue } from "./watch-state.ts";
import { IssueRow } from "./IssueRow.tsx";
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
}

// selector(2) + key(10) + status(13) + pr(7) + ago(4) + gaps = ~36
const FIXED_COLS = 40;
const CHROME_ROWS = 4;

export function IssueListView({
  issues,
  allIssues,
  selectedIndex,
  connected,
  lastServerMessageAt,
  filter,
  totalCount,
}: IssueListViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const titleWidth = Math.max(0, cols - FIXED_COLS);
  const maxVisible = Math.max(1, rows - CHROME_ROWS);

  // Periodic refresh for elapsed times
  const [, tick] = useReducer((c: number) => c + 1, 0);
  useEffect(() => { const id = setInterval(tick, 5000); return () => clearInterval(id); }, []);

  let startIndex = 0;
  if (issues.length > maxVisible) {
    startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), issues.length - maxVisible));
  }
  const visible = issues.slice(startIndex, startIndex + maxVisible);
  const hiddenAbove = startIndex;
  const hiddenBelow = Math.max(0, issues.length - startIndex - maxVisible);

  return (
    <Box flexDirection="column">
      <StatusBar
        issues={issues}
        totalCount={totalCount}
        filter={filter}
        connected={connected}
        lastServerMessageAt={lastServerMessageAt}
        allIssues={allIssues}
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
