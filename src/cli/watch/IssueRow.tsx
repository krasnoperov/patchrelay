import { Box, Text } from "ink";
import type { WatchIssue } from "./watch-state.ts";
import { summarizeIssueStatusNote } from "./issue-status-note.ts";

interface IssueRowProps {
  issue: WatchIssue;
  selected: boolean;
  titleWidth?: number | undefined;
}

const STATE_COLORS: Record<string, string> = {
  delegated: "cyan",
  implementing: "cyan",
  pr_open: "cyan",
  changes_requested: "yellow",
  repairing_ci: "cyan",
  awaiting_queue: "cyan",
  repairing_queue: "cyan",
  done: "green",
  failed: "red",
  escalated: "red",
  awaiting_input: "yellow",
};

const STATE_SHORT: Record<string, string> = {
  delegated: "delegated",
  implementing: "impl",
  pr_open: "pr open",
  changes_requested: "review fix",
  repairing_ci: "ci fix",
  awaiting_queue: "await queue",
  repairing_queue: "merge fix",
  done: "done",
  failed: "failed",
  escalated: "escalated",
  awaiting_input: "await input",
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
  return text.length > max ? text.slice(0, max) : text;
}

const TERMINAL_STATES = new Set(["done", "failed", "escalated", "awaiting_input"]);

function formatStatus(issue: WatchIssue): string {
  const state = STATE_SHORT[issue.factoryState] ?? issue.factoryState;
  // Terminal states: just the label, no run symbol
  if (TERMINAL_STATES.has(issue.factoryState)) return state;
  // Active/in-progress: show run status symbol
  const status = issue.activeRunType ? "running" : issue.latestRunStatus;
  const statusSym = status ? (STATUS_SHORT[status] ?? "") : "";
  if (statusSym) return `${state} ${statusSym}`;
  return state;
}

export function IssueRow({ issue, selected, titleWidth }: IssueRowProps): React.JSX.Element {
  const key = issue.issueKey ?? issue.projectId;
  const status = formatStatus(issue);
  const pr = formatPr(issue);
  const ago = relativeTime(issue.updatedAt);
  const tw = titleWidth ?? 30;
  const title = issue.title ? truncate(issue.title, tw) : "";
  const detail = selected ? summarizeIssueStatusNote(issue.statusNote) : undefined;

  return (
    <Box flexDirection="column" marginBottom={detail ? 1 : 0}>
      <Box>
        <Text color={selected ? "blueBright" : "white"} bold={selected}>
          {selected ? "\u25b8" : " "}
        </Text>
        <Text bold>{` ${key.padEnd(9)}`}</Text>
        <Text color={stateColor(issue.factoryState)}>{` ${status.padEnd(12)}`}</Text>
        <Text dimColor>{` ${pr.padEnd(6)}`}</Text>
        <Text dimColor>{` ${ago.padStart(3)}`}</Text>
        {title ? <Text dimColor>{` ${title}`}</Text> : null}
      </Box>
      {detail ? (
        <Box paddingLeft={4}>
          <Text dimColor wrap="wrap">{detail}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
