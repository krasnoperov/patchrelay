import { Box, Text } from "ink";
import type { WatchIssue, WatchThread } from "./watch-state.ts";
import { ThreadView } from "./ThreadView.tsx";
import { HelpBar } from "./HelpBar.tsx";

interface IssueDetailViewProps {
  issue: WatchIssue | undefined;
  thread: WatchThread | null;
}

export function IssueDetailView({ issue, thread }: IssueDetailViewProps): React.JSX.Element {
  if (!issue) {
    return (
      <Box flexDirection="column">
        <Text color="red">Issue not found.</Text>
        <HelpBar view="detail" />
      </Box>
    );
  }

  const key = issue.issueKey ?? issue.projectId;

  return (
    <Box flexDirection="column">
      <Box gap={2}>
        <Text bold>{key}</Text>
        <Text color="cyan">{issue.factoryState}</Text>
        {issue.activeRunType && <Text color="yellow">{issue.activeRunType}</Text>}
        {issue.prNumber !== undefined && <Text dimColor>PR #{issue.prNumber}</Text>}
      </Box>
      {issue.title && <Text dimColor>{issue.title}</Text>}
      <Text dimColor>{"─".repeat(72)}</Text>

      {thread ? (
        <ThreadView thread={thread} />
      ) : (
        <Text dimColor>Waiting for thread data...</Text>
      )}

      <Text dimColor>{"─".repeat(72)}</Text>
      <HelpBar view="detail" />
    </Box>
  );
}
