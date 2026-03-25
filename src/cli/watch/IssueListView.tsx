import { Box, Text } from "ink";
import type { WatchState } from "./watch-state.ts";
import { IssueRow } from "./IssueRow.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { HelpBar } from "./HelpBar.tsx";

interface IssueListViewProps {
  state: WatchState;
}

export function IssueListView({ state }: IssueListViewProps): React.JSX.Element {
  const { issues, selectedIndex, connected } = state;

  return (
    <Box flexDirection="column">
      <StatusBar issues={issues} connected={connected} />
      <Text dimColor>{"─".repeat(72)}</Text>
      {issues.length === 0 ? (
        <Text dimColor>No tracked issues.</Text>
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
      <Text dimColor>{"─".repeat(72)}</Text>
      <HelpBar view="list" />
    </Box>
  );
}
