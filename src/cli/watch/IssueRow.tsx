import { Box, Text } from "ink";
import type { WatchIssue } from "./watch-state.ts";
import { summarizeIssueStatusNote } from "./issue-status-note.ts";
import { progressBar, relativeTime, truncate } from "./format-utils.ts";

interface IssueRowProps {
  issue: WatchIssue;
  selected: boolean;
  titleWidth?: number | undefined;
}

const STATE_COLORS: Record<string, string> = {
  blocked: "yellow",
  ready: "blueBright",
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
  blocked: "blocked",
  ready: "ready",
  delegated: "delegated",
  implementing: "implementing",
  pr_open: "pr open",
  changes_requested: "review changes",
  repairing_ci: "repairing checks",
  awaiting_queue: "queued for merge",
  repairing_queue: "repairing merge queue",
  done: "done",
  failed: "failed",
  escalated: "escalated",
  awaiting_input: "awaiting input",
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

const TERMINAL_STATES = new Set(["done", "failed", "escalated", "awaiting_input"]);

interface StatusChip {
  text: string;
  color: string;
}

interface PipelineProgress {
  current: number;
  total: number;
  label: string;
}

function formatStatus(issue: WatchIssue): string {
  const effectiveState = issue.blockedByCount > 0 && !issue.activeRunType
    ? "blocked"
    : issue.readyForExecution && !issue.activeRunType
      ? "ready"
      : issue.factoryState;
  const state = STATE_SHORT[effectiveState] ?? effectiveState;
  // Terminal states: just the label, no run symbol
  if (TERMINAL_STATES.has(issue.factoryState)) return state;
  // Active/in-progress: show run status symbol
  const status = issue.activeRunType ? "running" : issue.latestRunStatus;
  const statusSym = status ? (STATUS_SHORT[status] ?? "") : "";
  if (statusSym) return `${state} ${statusSym}`;
  return state;
}

function buildStatusChips(issue: WatchIssue): StatusChip[] {
  const effectiveState = issue.blockedByCount > 0 && !issue.activeRunType
    ? "blocked"
    : issue.readyForExecution && !issue.activeRunType
      ? "ready"
      : issue.factoryState;

  const chips: StatusChip[] = [{
    text: `${stateIcon(effectiveState)} ${STATE_SHORT[effectiveState] ?? effectiveState}`,
    color: stateColor(effectiveState),
  }];

  if (issue.prNumber !== undefined) {
    chips.push({ text: `PR #${issue.prNumber}`, color: "cyan" });
  }

  const reviewChip = buildReviewChip(issue.prReviewState);
  if (reviewChip) chips.push(reviewChip);

  const checkChip = buildCheckChip(issue.prCheckStatus);
  if (checkChip) chips.push(checkChip);
  const checksProgressChip = buildChecksProgressChip(issue);
  if (checksProgressChip) chips.push(checksProgressChip);

  const mergeChip = buildMergeChip(issue);
  if (mergeChip) chips.push(mergeChip);

  if (issue.blockedByCount > 0) {
    chips.push({
      text: `blocked by ${issue.blockedByKeys.join(", ")}`,
      color: "yellow",
    });
  }

  return chips;
}

function stateIcon(state: string): string {
  switch (state) {
    case "implementing":
    case "repairing_ci":
    case "repairing_queue":
      return "\u25b8";
    case "awaiting_queue":
      return "\u25a4";
    case "done":
      return "\u2713";
    case "failed":
    case "escalated":
      return "\u2717";
    case "blocked":
      return "!";
    case "ready":
      return "+";
    default:
      return "\u2022";
  }
}

function buildReviewChip(reviewState?: string): StatusChip | null {
  switch (reviewState) {
    case "approved":
      return { text: "\u2713 review approved", color: "green" };
    case "changes_requested":
      return { text: "\u2717 changes requested", color: "yellow" };
    case "commented":
      return { text: "\u2022 review commented", color: "yellow" };
    case "dismissed":
      return { text: "\u2013 review dismissed", color: "yellow" };
    default:
      return null;
  }
}

function buildCheckChip(checkState?: string): StatusChip | null {
  switch (checkState) {
    case "passed":
    case "success":
      return { text: "\u2713 checks passed", color: "green" };
    case "failed":
    case "failure":
      return { text: "\u2717 checks failed", color: "red" };
    case "pending":
    case "in_progress":
    case "queued":
      return { text: "\u25cf checks running", color: "yellow" };
    default:
      return null;
  }
}

function buildChecksProgressChip(issue: WatchIssue): StatusChip | null {
  const summary = issue.prChecksSummary;
  if (!summary || summary.total <= 0) return null;
  const text = summary.failed > 0
    ? `checks ${summary.completed}/${summary.total} failed`
    : summary.pending > 0
      ? `checks ${summary.completed}/${summary.total} running`
      : `checks ${summary.completed}/${summary.total} passed`;
  const color = summary.failed > 0 ? "red" : summary.pending > 0 ? "yellow" : "green";
  return { text, color };
}

function buildMergeChip(issue: WatchIssue): StatusChip | null {
  if (issue.prNumber === undefined) return null;
  switch (issue.factoryState) {
    case "awaiting_queue":
      return { text: "\u25a4 queued for merge", color: "cyan" };
    case "repairing_queue":
      return { text: "! merge queue repair", color: "yellow" };
    case "done":
      return { text: "\u2713 merged", color: "green" };
    case "pr_open":
      if (issue.prReviewState === "approved" && issue.prCheckStatus === "passed") {
        return { text: "\u2713 merge ready", color: "green" };
      }
      return { text: "\u2022 PR open", color: "cyan" };
    default:
      return null;
  }
}

function buildPrimaryBlocker(issue: WatchIssue): StatusChip | null {
  if (issue.blockedByCount > 0) {
    return {
      text: `Waiting on ${issue.blockedByKeys.join(", ")}`,
      color: "yellow",
    };
  }
  if (issue.prCheckStatus === "failed") {
    const failedCheck = issue.latestFailureCheckName ?? "PR checks";
    return {
      text: `${failedCheck} failed`,
      color: "red",
    };
  }
  if (issue.prReviewState === "changes_requested") {
    return {
      text: "Review changes requested",
      color: "yellow",
    };
  }
  if (issue.prNumber !== undefined && !issue.prReviewState && issue.factoryState !== "done") {
    return {
      text: "Waiting for review approval",
      color: "yellow",
    };
  }
  if (issue.factoryState === "awaiting_queue") {
    return {
      text: "Waiting for merge queue turn",
      color: "yellow",
    };
  }
  return null;
}

function buildPipelineProgress(issue: WatchIssue): PipelineProgress {
  switch (issue.factoryState) {
    case "delegated":
      return { current: 1, total: 4, label: "delegated" };
    case "implementing":
      return { current: 1, total: 4, label: "implementing" };
    case "pr_open":
    case "changes_requested":
    case "repairing_ci":
      return { current: 2, total: 4, label: "pr checks" };
    case "awaiting_queue":
    case "repairing_queue":
      return { current: 3, total: 4, label: "merge queue" };
    case "done":
      return { current: 4, total: 4, label: "merged" };
    case "failed":
    case "escalated":
    case "awaiting_input":
      return { current: 4, total: 4, label: "stopped" };
    default:
      return { current: 1, total: 4, label: "queued" };
  }
}

export function IssueRow({ issue, selected, titleWidth }: IssueRowProps): React.JSX.Element {
  const key = issue.issueKey ?? issue.projectId;
  const ago = relativeTime(issue.updatedAt);
  const tw = titleWidth ?? 40;
  const title = issue.title ? truncate(issue.title, tw) : "";
  const detail = selected ? summarizeIssueStatusNote(issue.statusNote) : undefined;
  const status = formatStatus(issue);
  const chips = buildStatusChips(issue);
  const blocker = buildPrimaryBlocker(issue);
  const pipeline = buildPipelineProgress(issue);

  return (
    <Box flexDirection="column" marginBottom={detail ? 1 : 0}>
      <Box>
        <Text color={selected ? "blueBright" : "white"} bold={selected}>
          {selected ? "\u25b8" : " "}
        </Text>
        <Text bold>{` ${key}`}</Text>
        <Text dimColor>{`  ${ago}`}</Text>
        <Text dimColor>{`  ${status}`}</Text>
      </Box>
      <Box paddingLeft={2} flexWrap="wrap">
        {title ? <Text>{title}</Text> : null}
      </Box>
      <Box paddingLeft={2} flexWrap="wrap">
        {chips.map((chip, index) => (
          <Box key={`${key}-chip-${index}`} marginRight={1}>
            <Text color={chip.color}>[{chip.text}]</Text>
          </Box>
        ))}
      </Box>
      <Box paddingLeft={2} gap={1}>
        <Text dimColor>{progressBar(pipeline.current, pipeline.total, 8)}</Text>
        <Text dimColor>{pipeline.label}</Text>
        {blocker ? (
          <>
            <Text dimColor>|</Text>
            <Text color={blocker.color}>{blocker.text}</Text>
          </>
        ) : null}
      </Box>
      {detail ? (
        <Box paddingLeft={4}>
          <Text dimColor wrap="wrap">{detail}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
