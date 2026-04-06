import { Box, Text } from "ink";
import type { WatchIssue } from "./watch-state.ts";
import { summarizeIssueStatusNote } from "./issue-status-note.ts";
import { relativeTime, truncate } from "./format-utils.ts";

interface IssueRowProps {
  issue: WatchIssue;
  selected: boolean;
  titleWidth?: number | undefined;
}

// ─── State display ──────────────────────────────────────────────

const TERMINAL_STATES = new Set(["done", "failed", "escalated", "awaiting_input"]);

interface StateDisplay {
  label: string;
  color: string;
}

function effectiveState(issue: WatchIssue): string {
  if (issue.blockedByCount > 0 && !issue.activeRunType) return "blocked";
  if (issue.readyForExecution && !issue.activeRunType) return "ready";
  return issue.factoryState;
}

function sessionDisplay(issue: WatchIssue): StateDisplay {
  switch (issue.sessionState) {
    case "running":
      return { label: "running", color: "cyan" };
    case "idle":
      return { label: "idle", color: "blueBright" };
    case "waiting_input":
      return { label: "needs input", color: "yellow" };
    case "done":
      return { label: "done", color: "green" };
    case "failed":
      return { label: "failed", color: "red" };
    default:
      return { label: "unknown", color: "white" };
  }
}

function stageLabel(issue: WatchIssue): string {
  const state = effectiveState(issue);
  switch (state) {
    case "blocked": return "blocked";
    case "ready": return "ready";
    case "delegated": return "delegated";
    case "implementing": return "implementing";
    case "pr_open": return "PR open";
    case "changes_requested": return "review changes";
    case "repairing_ci": return "repairing CI";
    case "awaiting_queue": return "waiting downstream";
    case "repairing_queue": return "repairing queue";
    case "done": return "merged";
    case "failed": return "failed";
    case "escalated": return "escalated";
    case "awaiting_input": return "needs input";
    default: return state;
  }
}

// ─── Context facts (what matters right now) ─────────────────────

function buildFacts(issue: WatchIssue): Array<{ text: string; color?: string }> {
  const facts: Array<{ text: string; color?: string }> = [];
  const rereviewNeeded = issue.prReviewState === "changes_requested"
    && (issue.prCheckStatus === "passed" || issue.prCheckStatus === "success")
    && !issue.activeRunType;

  // PR number
  if (issue.prNumber !== undefined) {
    facts.push({ text: `PR #${issue.prNumber}` });
  }

  facts.push({ text: `stage ${stageLabel(issue)}` });

  // Review state — only show when it matters (not yet approved, or changes requested)
  if (issue.prReviewState === "approved") {
    facts.push({ text: "approved", color: "green" });
  } else if (rereviewNeeded) {
    facts.push({ text: "re-review needed", color: "yellow" });
  } else if (issue.prReviewState === "changes_requested") {
    facts.push({ text: "changes requested", color: "yellow" });
  } else if (issue.prNumber !== undefined && !issue.prReviewState && !TERMINAL_STATES.has(issue.factoryState)) {
    facts.push({ text: "awaiting review", color: "yellow" });
  }

  // Check status — compact
  if (issue.prCheckStatus === "passed" || issue.prCheckStatus === "success") {
    facts.push({ text: "checks passed", color: "green" });
  } else if (issue.prCheckStatus === "failed" || issue.prCheckStatus === "failure") {
    const failedNames = issue.prChecksSummary?.failedNames ?? [];
    const checkInfo = issue.latestFailureCheckName
      ?? (failedNames.length > 0 ? failedNames.slice(0, 2).join(", ") : "checks");
    facts.push({ text: `${checkInfo} failed`, color: "red" });
  } else if (issue.prCheckStatus === "pending" || issue.prCheckStatus === "in_progress") {
    const summary = issue.prChecksSummary;
    if (summary && summary.total > 0) {
      facts.push({ text: `checks ${summary.completed}/${summary.total}`, color: "yellow" });
    } else {
      facts.push({ text: "checks running", color: "yellow" });
    }
  }

  // Blocker
  if (issue.blockedByCount > 0) {
    facts.push({ text: `waiting on ${issue.blockedByKeys.join(", ")}`, color: "yellow" });
  }

  return facts;
}

// ─── What's blocking progress ───────────────────────────────────

function blockerText(issue: WatchIssue): string | null {
  const rereviewNeeded = issue.prReviewState === "changes_requested"
    && (issue.prCheckStatus === "passed" || issue.prCheckStatus === "success")
    && !issue.activeRunType;
  if (issue.sessionState === "waiting_input") return issue.waitingReason ?? "Waiting for input";
  if (issue.waitingReason && !issue.activeRunType) return issue.waitingReason;
  if (issue.blockedByCount > 0) return `Waiting on ${issue.blockedByKeys.join(", ")}`;
  if (issue.factoryState === "repairing_queue") return "Merge queue conflict, repairing branch";
  if (issue.factoryState === "repairing_ci") {
    const check = issue.latestFailureCheckName ?? "CI";
    return `Repairing ${check}`;
  }
  if (issue.prCheckStatus === "failed" || issue.prCheckStatus === "failure") {
    const check = issue.latestFailureCheckName ?? "checks";
    return `${check} failed`;
  }
  if (rereviewNeeded) return "Awaiting re-review after requested changes";
  if (issue.prReviewState === "changes_requested") return "Review changes requested";
  return null;
}

// ─── Render ─────────────────────────────────────────────────────

export function IssueRow({ issue, selected, titleWidth }: IssueRowProps): React.JSX.Element {
  const key = issue.issueKey ?? issue.projectId;
  const tw = titleWidth ?? 60;
  const title = issue.title ? truncate(issue.title, tw) : "";
  const detail = selected ? summarizeIssueStatusNote(issue.statusNote) : undefined;
  const session = sessionDisplay(issue);
  const facts = buildFacts(issue);
  const blocker = selected ? blockerText(issue) : null;

  const isTerminal = TERMINAL_STATES.has(issue.factoryState);

  // Terminal issues: compact single line
  if (isTerminal && !selected) {
    return (
      <Box>
        <Text dimColor> </Text>
        <Text dimColor>{` ${key}`}</Text>
        <Text dimColor>{`  ${relativeTime(issue.updatedAt).padStart(4)}`}</Text>
        <Text>{`  `}</Text>
        <Text color={session.color}>{session.label}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={detail ? 1 : 0}>
      {/* Line 1: key · time · status · facts */}
      <Box>
        <Text color={selected ? "blueBright" : "gray"}>{selected ? "\u25b8" : " "}</Text>
        <Text bold>{` ${key}`}</Text>
        <Text dimColor>{`  ${relativeTime(issue.updatedAt).padStart(4)}`}</Text>
        <Text>{`  `}</Text>
        <Text color={session.color}>{session.label}</Text>
        {facts.length > 0 && (
          <Text dimColor>{` \u00b7 `}</Text>
        )}
        {facts.map((fact, i) => (
          <Text key={i}>
            {i > 0 ? <Text dimColor>{` \u00b7 `}</Text> : null}
            <Text color={fact.color ?? "white"} dimColor={!fact.color}>{fact.text}</Text>
          </Text>
        ))}
      </Box>
      {/* Line 2: title */}
      {title ? (
        <Box paddingLeft={2}>
          <Text dimColor>{title}</Text>
        </Box>
      ) : null}
      {/* Line 3 (selected only): blocker explanation */}
      {blocker ? (
        <Box paddingLeft={2}>
          <Text color="yellow">{blocker}</Text>
        </Box>
      ) : null}
      {/* Line 4 (selected only): status note from agent */}
      {detail ? (
        <Box paddingLeft={4}>
          <Text dimColor wrap="wrap">{detail}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
