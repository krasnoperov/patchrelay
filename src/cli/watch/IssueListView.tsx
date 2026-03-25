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
  filter: WatchFilter;
  totalCount: number;
}

// Fixed columns: selector(2) + key(10) + state(11) + run(11) + pr(7) + ago(4) + gaps(6) = ~51
const FIXED_COLS = 51;

export function IssueListView({ issues, allIssues, selectedIndex, connected, filter, totalCount }: IssueListViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const titleWidth = Math.max(0, cols - FIXED_COLS);

  return (
    <Box flexDirection="column">
      <StatusBar issues={issues} totalCount={totalCount} filter={filter} connected={connected} allIssues={allIssues} />
      <Box marginTop={1} flexDirection="column">
        {issues.length === 0 ? (
          <Text dimColor>No issues match the current filter.</Text>
        ) : (
          issues.map((issue, index) => (
            <IssueRow
              key={issue.issueKey ?? `${issue.projectId}-${index}`}
              issue={issue}
              selected={index === selectedIndex}
              titleWidth={titleWidth}
            />
          ))
        )}
      </Box>
      <Box marginTop={1}>
        <HelpBar view="list" />
      </Box>
    </Box>
  );
}
