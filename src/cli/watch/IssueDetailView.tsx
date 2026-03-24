import { Box, Text } from "ink";
import type { WatchIssue } from "./watch-state.ts";
import { HelpBar } from "./HelpBar.tsx";

interface IssueDetailViewProps {
  issue: WatchIssue | undefined;
}

export function IssueDetailView({ issue }: IssueDetailViewProps): React.JSX.Element {
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
      <Text dimColor>
        Detail view with live thread items will be available in Phase 2.
      </Text>
      <Text dimColor>
        Current state: {issue.factoryState}
        {issue.latestRunStatus ? ` | Latest run: ${issue.latestRunType}:${issue.latestRunStatus}` : ""}
        {issue.prCheckStatus ? ` | Checks: ${issue.prCheckStatus}` : ""}
        {issue.prReviewState ? ` | Review: ${issue.prReviewState}` : ""}
      </Text>
      <Text dimColor>{"─".repeat(72)}</Text>
      <HelpBar view="detail" />
    </Box>
  );
}
