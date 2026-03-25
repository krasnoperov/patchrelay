import { Box, Text } from "ink";
import type { WatchIssue } from "./watch-state.ts";

interface IssueRowProps {
  issue: WatchIssue;
  selected: boolean;
  titleWidth?: number | undefined;
}

const STATE_COLORS: Record<string, string> = {
  delegated: "blue",
  preparing: "blue",
  implementing: "yellow",
  pr_open: "cyan",
  changes_requested: "magenta",
  repairing_ci: "magenta",
  awaiting_queue: "green",
  repairing_queue: "magenta",
  done: "green",
  failed: "red",
  escalated: "red",
  awaiting_input: "yellow",
};

const STATE_SHORT: Record<string, string> = {
  delegated: "queued",
  preparing: "prep",
  implementing: "impl",
  pr_open: "pr open",
  changes_requested: "changes",
  repairing_ci: "ci fix",
  awaiting_queue: "merging",
  repairing_queue: "merge fix",
  done: "done",
  failed: "failed",
  escalated: "escalated",
  awaiting_input: "input",
};

const RUN_SHORT: Record<string, string> = {
  implementation: "impl",
  ci_repair: "ci",
  review_fix: "review",
  queue_repair: "merge",
};

const STATUS_SHORT: Record<string, string> = {
  running: "\u25b8",
  completed: "\u2713",
  failed: "\u2717",
  released: "\u2013",
};

function stateColor(state: string): string {
  return STATE_COLORS[state] ?? "white";
}

function formatRun(issue: WatchIssue): string {
  const run = issue.activeRunType ?? issue.latestRunType;
  if (!run) return "";
  const runLabel = RUN_SHORT[run] ?? run;
  const status = issue.activeRunType ? "running" : issue.latestRunStatus;
  const statusLabel = status ? STATUS_SHORT[status] ?? status : "";
  return `${runLabel} ${statusLabel}`;
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
  if (max <= 0) return "";
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

export function IssueRow({ issue, selected, titleWidth }: IssueRowProps): React.JSX.Element {
  const key = issue.issueKey ?? issue.projectId;
  const state = STATE_SHORT[issue.factoryState] ?? issue.factoryState;
  const run = formatRun(issue);
  const pr = formatPr(issue);
  const ago = relativeTime(issue.updatedAt);
  const tw = titleWidth ?? 30;
  const title = issue.title ? truncate(issue.title, tw) : "";

  return (
    <Box>
      <Text color={selected ? "blueBright" : "white"} bold={selected}>
        {selected ? "\u25b8" : " "}
      </Text>
      <Text bold>{` ${key.padEnd(9)}`}</Text>
      <Text color={stateColor(issue.factoryState)}>{` ${state.padEnd(10)}`}</Text>
      <Text dimColor>{` ${run.padEnd(10)}`}</Text>
      <Text dimColor>{` ${pr.padEnd(6)}`}</Text>
      <Text dimColor>{` ${ago.padStart(3)}`}</Text>
      {title ? <Text dimColor>{` ${title}`}</Text> : null}
    </Box>
  );
}
