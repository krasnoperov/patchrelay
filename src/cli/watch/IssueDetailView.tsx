import { useEffect, useReducer } from "react";
import { Box, Text } from "ink";
import type { TimelineEntry } from "./timeline-builder.ts";
import type { WatchDiffSummary, WatchIssue, WatchTokenUsage } from "./watch-state.ts";
import { Timeline } from "./Timeline.tsx";
import { HelpBar } from "./HelpBar.tsx";

interface IssueDetailViewProps {
  issue: WatchIssue | undefined;
  timeline: TimelineEntry[];
  follow: boolean;
  activeRunStartedAt: string | null;
  tokenUsage: WatchTokenUsage | null;
  diffSummary: WatchDiffSummary | null;
  plan: Array<{ step: string; status: string }> | null;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function ElapsedTime({ startedAt }: { startedAt: string }): React.JSX.Element {
  const [, tick] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const elapsed = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return <Text dimColor>{minutes}m {String(seconds).padStart(2, "0")}s</Text>;
}

function planStepSymbol(status: string): string {
  if (status === "completed") return "\u2713";
  if (status === "inProgress") return "\u25b8";
  return " ";
}

function planStepColor(status: string): string {
  if (status === "completed") return "green";
  if (status === "inProgress") return "yellow";
  return "white";
}

export function IssueDetailView({
  issue,
  timeline,
  follow,
  activeRunStartedAt,
  tokenUsage,
  diffSummary,
  plan,
}: IssueDetailViewProps): React.JSX.Element {
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
        {activeRunStartedAt && <ElapsedTime startedAt={activeRunStartedAt} />}
      </Box>
      {issue.title && <Text dimColor>{issue.title}</Text>}

      <Box gap={2}>
        {tokenUsage && (
          <Text dimColor>
            tokens: {formatTokens(tokenUsage.inputTokens)} in / {formatTokens(tokenUsage.outputTokens)} out
          </Text>
        )}
        {diffSummary && diffSummary.filesChanged > 0 && (
          <Text dimColor>
            diff: {diffSummary.filesChanged} file{diffSummary.filesChanged !== 1 ? "s" : ""}
            {" "}+{diffSummary.linesAdded} -{diffSummary.linesRemoved}
          </Text>
        )}
        {follow && <Text color="yellow">follow</Text>}
      </Box>

      {plan && plan.length > 0 && (
        <Box flexDirection="column">
          {plan.map((entry, i) => (
            <Box key={`plan-${i}`} gap={1}>
              <Text color={planStepColor(entry.status)}>[{planStepSymbol(entry.status)}]</Text>
              <Text>{entry.step}</Text>
            </Box>
          ))}
        </Box>
      )}

      <Text dimColor>{"─".repeat(72)}</Text>
      <Timeline entries={timeline} follow={follow} />
      <Text dimColor>{"─".repeat(72)}</Text>
      <HelpBar view="detail" follow={follow} />
    </Box>
  );
}
