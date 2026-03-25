import { Box, Text } from "ink";
import type { WatchFeedEntry, WatchIssue, WatchReport, WatchThread } from "./watch-state.ts";
import { ThreadView } from "./ThreadView.tsx";
import { FeedTimeline } from "./FeedTimeline.tsx";
import { HelpBar } from "./HelpBar.tsx";

interface IssueDetailViewProps {
  issue: WatchIssue | undefined;
  thread: WatchThread | null;
  report: WatchReport | null;
  follow: boolean;
  feedEntries: WatchFeedEntry[];
}

function truncate(text: string, max: number): string {
  const line = text.replace(/\n/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function ThreadStatusBar({ thread, follow }: { thread: WatchThread; follow: boolean }): React.JSX.Element {
  return (
    <Box gap={2}>
      {thread.tokenUsage && (
        <Text dimColor>
          tokens: {formatTokens(thread.tokenUsage.inputTokens)} in / {formatTokens(thread.tokenUsage.outputTokens)} out
        </Text>
      )}
      {thread.diffSummary && thread.diffSummary.filesChanged > 0 && (
        <Text dimColor>
          diff: {thread.diffSummary.filesChanged} file{thread.diffSummary.filesChanged !== 1 ? "s" : ""}
          {" "}+{thread.diffSummary.linesAdded} -{thread.diffSummary.linesRemoved}
        </Text>
      )}
      {follow && <Text color="yellow">follow</Text>}
    </Box>
  );
}

function ReportView({ report }: { report: WatchReport }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Box gap={2}>
        <Text dimColor>Latest run:</Text>
        <Text bold>{report.runType}</Text>
        <Text color={report.status === "completed" ? "green" : "red"}>{report.status}</Text>
      </Box>

      {report.summary && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Summary:</Text>
          <Text wrap="wrap">{truncate(report.summary, 300)}</Text>
        </Box>
      )}

      {report.commands.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Commands ({report.commands.length}):</Text>
          {report.commands.slice(-10).map((cmd, i) => (
            <Box key={`cmd-${i}`} gap={1}>
              <Text color={cmd.exitCode === 0 ? "green" : cmd.exitCode !== undefined ? "red" : "white"}>
                {cmd.exitCode === 0 ? "\u2713" : cmd.exitCode !== undefined ? "\u2717" : " "}
              </Text>
              <Text dimColor>$ </Text>
              <Text>{truncate(cmd.command, 60)}</Text>
              {cmd.durationMs !== undefined && <Text dimColor> {(cmd.durationMs / 1000).toFixed(1)}s</Text>}
            </Box>
          ))}
        </Box>
      )}

      <Box marginTop={1} gap={2}>
        {report.fileChanges > 0 && <Text dimColor>{report.fileChanges} file change{report.fileChanges !== 1 ? "s" : ""}</Text>}
        {report.toolCalls > 0 && <Text dimColor>{report.toolCalls} tool call{report.toolCalls !== 1 ? "s" : ""}</Text>}
        {report.assistantMessages.length > 0 && <Text dimColor>{report.assistantMessages.length} message{report.assistantMessages.length !== 1 ? "s" : ""}</Text>}
      </Box>
    </Box>
  );
}

export function IssueDetailView({ issue, thread, report, follow, feedEntries }: IssueDetailViewProps): React.JSX.Element {
  if (!issue) {
    return (
      <Box flexDirection="column">
        <Text color="red">Issue not found.</Text>
        <HelpBar view="detail" follow={follow} />
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
      {thread && <ThreadStatusBar thread={thread} follow={follow} />}
      <Text dimColor>{"─".repeat(72)}</Text>

      {thread ? (
        <ThreadView thread={thread} follow={follow} />
      ) : report ? (
        <ReportView report={report} />
      ) : (
        <Text dimColor>Loading...</Text>
      )}

      {feedEntries.length > 0 && (
        <>
          <Text dimColor>{"─".repeat(72)}</Text>
          <Text bold dimColor>Events:</Text>
          <FeedTimeline entries={feedEntries} maxEntries={follow ? 5 : undefined} />
        </>
      )}
      <Text dimColor>{"─".repeat(72)}</Text>
      <HelpBar view="detail" follow={follow} />
    </Box>
  );
}
