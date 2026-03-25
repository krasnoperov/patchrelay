import { Box, Text } from "ink";
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

export function IssueListView({ issues, allIssues, selectedIndex, connected, filter, totalCount }: IssueListViewProps): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <StatusBar issues={issues} totalCount={totalCount} filter={filter} connected={connected} allIssues={allIssues} />
      <Text dimColor>{"\u2500".repeat(72)}</Text>
      {issues.length === 0 ? (
        <Text dimColor>No issues match the current filter.</Text>
      ) : (
        <Box flexDirection="column">
          {issues.map((issue, index) => (
            <IssueRow
              key={issue.issueKey ?? `${issue.projectId}-${index}`}
              issue={issue}
              selected={index === selectedIndex}
            />
          ))}
        </Box>
      )}
      <Text dimColor>{"\u2500".repeat(72)}</Text>
      <HelpBar view="list" />
    </Box>
  );
}
