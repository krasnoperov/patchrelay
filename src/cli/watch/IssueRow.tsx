import { Box, Text } from "ink";
import type { WatchIssue } from "./watch-state.ts";

interface IssueRowProps {
  issue: WatchIssue;
  selected: boolean;
}

const STATE_COLORS: Record<string, string> = {
  delegated: "blue",
  preparing: "blue",
  implementing: "yellow",
  pr_open: "cyan",
  awaiting_review: "cyan",
  changes_requested: "magenta",
  repairing_ci: "magenta",
  awaiting_queue: "green",
  repairing_queue: "magenta",
  done: "green",
  failed: "red",
  escalated: "red",
  awaiting_input: "yellow",
};

function stateColor(state: string): string {
  return STATE_COLORS[state] ?? "white";
}

function formatPr(issue: WatchIssue): string {
  if (!issue.prNumber) return "";
  const parts = [`PR #${issue.prNumber}`];
  if (issue.prReviewState === "approved") parts.push("approved");
  else if (issue.prReviewState === "changes_requested") parts.push("changes");
  if (issue.prCheckStatus === "passed") parts.push("checks ok");
  else if (issue.prCheckStatus === "failed") parts.push("checks fail");
  return parts.join(" ");
}

export function IssueRow({ issue, selected }: IssueRowProps): React.JSX.Element {
  const key = issue.issueKey ?? issue.projectId;
  const state = issue.factoryState;
  const run = issue.activeRunType ?? issue.latestRunType;
  const runStatus = issue.activeRunType ? "running" : issue.latestRunStatus;
  const pr = formatPr(issue);

  return (
    <Box gap={1}>
      <Text color={selected ? "blueBright" : "white"} bold={selected}>
        {selected ? "▸" : " "}
      </Text>
      <Text bold>{key.padEnd(10)}</Text>
      <Text color={stateColor(state)}>{state.padEnd(20)}</Text>
      <Text dimColor>{run ? `${run}${runStatus ? `:${runStatus}` : ""}`.padEnd(25) : "".padEnd(25)}</Text>
      {pr ? <Text dimColor>{pr}</Text> : null}
    </Box>
  );
}
