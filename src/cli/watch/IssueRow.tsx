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
  const parts = [`#${issue.prNumber}`];
  if (issue.prReviewState === "approved") parts.push("\u2713");
  else if (issue.prReviewState === "changes_requested") parts.push("\u2717");
  return parts.join("");
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

export function IssueRow({ issue, selected }: IssueRowProps): React.JSX.Element {
  const key = issue.issueKey ?? issue.projectId;
  const state = issue.factoryState;
  const run = issue.activeRunType ?? issue.latestRunType;
  const runStatus = issue.activeRunType ? "running" : issue.latestRunStatus;
  const pr = formatPr(issue);
  const ago = relativeTime(issue.updatedAt);
  const title = issue.title ? truncate(issue.title, 40) : "";

  return (
    <Box gap={1}>
      <Text color={selected ? "blueBright" : "white"} bold={selected}>
        {selected ? "\u25b8" : " "}
      </Text>
      <Text bold>{key.padEnd(10)}</Text>
      <Text color={stateColor(state)}>{state.padEnd(18)}</Text>
      <Text dimColor>{run ? `${run}:${runStatus ?? "?"}`.padEnd(22) : "".padEnd(22)}</Text>
      {pr ? <Text dimColor>{pr.padEnd(6)}</Text> : <Text dimColor>{"".padEnd(6)}</Text>}
      <Text dimColor>{ago.padStart(4)}</Text>
      {title ? <Text dimColor> {title}</Text> : null}
    </Box>
  );
}
