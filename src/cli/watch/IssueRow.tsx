import { Box, Text } from "ink";
import { hasOpenPr } from "../../pr-state.ts";
import type { WatchIssue } from "./watch-state.ts";
import { summarizeIssueStatusNote } from "./issue-status-note.ts";
import { relativeTime, truncate } from "./format-utils.ts";
import { measureRenderedTextRows } from "./layout-measure.ts";
import {
  hasDisplayPrBlocker,
  isApprovedReviewState,
  isAwaitingReviewState,
  isChangesRequestedReviewState,
  isRereviewNeeded,
  prChecksFact,
} from "./pr-status.ts";

interface IssueRowProps {
  issue: WatchIssue;
  selected: boolean;
  titleWidth?: number | undefined;
}

// ─── State display ──────────────────────────────────────────────

const TERMINAL_STATES = new Set(["done", "failed", "escalated"]);

interface StateDisplay {
  label: string;
  color: string;
}

function needsOperatorIntervention(issue: WatchIssue): boolean {
  return issue.sessionState === "failed" || issue.factoryState === "failed" || issue.factoryState === "escalated";
}

function effectiveState(issue: WatchIssue): string {
  if (issue.sessionState === "done") return "done";
  if (issue.sessionState === "failed") return "failed";
  if (issue.completionCheckActive) return "completion_check";
  if (issue.blockedByCount > 0 && !issue.activeRunType) return "blocked";
  if (issue.sessionState === "waiting_input") return "awaiting_input";
  if (hasOpenPr(issue.prNumber, issue.prState)) return issue.factoryState;
  if (issue.readyForExecution && !issue.activeRunType && !hasDisplayPrBlocker(issue)) return "ready";
  return issue.factoryState;
}

function sessionDisplay(issue: WatchIssue): StateDisplay {
  if (needsOperatorIntervention(issue)) {
    return { label: "needs help", color: "red" };
  }
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
    case "completion_check": return "completion check";
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

function buildFacts(issue: WatchIssue, selected: boolean): Array<{ text: string; color?: string }> {
  const facts: Array<{ text: string; color?: string }> = [];
  const rereviewNeeded = isRereviewNeeded(issue);

  // PR number
  if (issue.prNumber !== undefined) {
    facts.push({ text: `PR #${issue.prNumber}` });
  }

  if (!issue.sessionState) {
    facts.push({ text: `stage ${stageLabel(issue)}` });
  } else if (selected) {
    facts.push({ text: `internal stage ${stageLabel(issue)}` });
  }

  if (issue.waitingReason && issue.sessionState === "waiting_input") {
    facts.push({ text: issue.waitingReason, color: "yellow" });
  }
  if (needsOperatorIntervention(issue)) {
    facts.push({ text: "operator action needed", color: "red" });
  }

  // Review state — only show when it matters (not yet approved, or changes requested)
  if (isApprovedReviewState(issue.prReviewState)) {
    facts.push({ text: "approved", color: "green" });
  } else if (rereviewNeeded) {
    facts.push({ text: "re-review needed", color: "yellow" });
  } else if (isChangesRequestedReviewState(issue.prReviewState)) {
    facts.push({ text: "changes requested", color: "yellow" });
  } else if (
    hasOpenPr(issue.prNumber, issue.prState)
    && (isAwaitingReviewState(issue.prReviewState) || (!issue.prReviewState && !TERMINAL_STATES.has(effectiveState(issue))))
  ) {
    facts.push({ text: "awaiting review", color: "yellow" });
  }

  if (issue.factoryState === "awaiting_queue") {
    facts.push({ text: "merge queue", color: "cyan" });
  }

  // Check status — compact
  const checksFact = prChecksFact(issue);
  if (checksFact) {
    facts.push(checksFact);
  }

  // Blocker
  if (issue.blockedByCount > 0) {
    facts.push({ text: `waiting on ${issue.blockedByKeys.join(", ")}`, color: "yellow" });
  }

  return facts;
}

// ─── What's blocking progress ───────────────────────────────────

function blockerText(issue: WatchIssue): string | null {
  const rereviewNeeded = isRereviewNeeded(issue);
  if (issue.sessionState === "waiting_input") return issue.waitingReason ?? "Waiting for input";
  if (needsOperatorIntervention(issue)) return issue.statusNote ?? issue.waitingReason ?? "Needs operator intervention";
  if (issue.completionCheckActive) return "No PR found; checking next step";
  if (issue.waitingReason && issue.activeRunType && issue.factoryState === "pr_open") return issue.waitingReason;
  if (issue.waitingReason && issue.activeRunType && issue.factoryState === "awaiting_queue") return issue.waitingReason;
  if (issue.waitingReason && !issue.activeRunType) return issue.waitingReason;
  if (issue.blockedByCount > 0) return `Waiting on ${issue.blockedByKeys.join(", ")}`;
  if (effectiveState(issue) === "repairing_queue") return "Merge queue conflict, repairing branch";
  if (effectiveState(issue) === "repairing_ci") {
    const check = issue.latestFailureCheckName ?? "CI";
    return `Repairing ${check}`;
  }
  const checksFact = prChecksFact(issue);
  if (checksFact?.color === "red") {
    return checksFact.text;
  }
  if (checksFact?.color === "yellow" && checksFact.text.startsWith("checks ")) {
    return `${checksFact.text} still running`;
  }
  if (rereviewNeeded) return "Awaiting re-review after requested changes";
  if (isChangesRequestedReviewState(issue.prReviewState)) return "Review changes requested";
  if (hasOpenPr(issue.prNumber, issue.prState) && isAwaitingReviewState(issue.prReviewState)) return "Awaiting review";
  return null;
}

// ─── Render ─────────────────────────────────────────────────────

export function IssueRow({ issue, selected, titleWidth }: IssueRowProps): React.JSX.Element {
  const key = issue.issueKey ?? issue.projectId;
  const tw = titleWidth ?? 60;
  const title = issue.title ? truncate(issue.title, tw) : "";
  const detail = selected ? summarizeIssueStatusNote(issue.statusNote) : undefined;
  const session = sessionDisplay(issue);
  const facts = buildFacts(issue, selected);
  const blocker = selected ? blockerText(issue) : null;

  const isTerminal = TERMINAL_STATES.has(effectiveState(issue));

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
      {selected && issue.factoryState && issue.sessionState ? (
        <Box paddingLeft={4}>
          <Text dimColor>{`Debug stage: ${stageLabel(issue)}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function estimateIssueRowHeight(issue: WatchIssue, selected: boolean, cols: number, titleWidth?: number): number {
  const width = Math.max(20, cols);
  const key = issue.issueKey ?? issue.projectId;
  const tw = titleWidth ?? 60;
  const title = issue.title ? truncate(issue.title, tw) : "";
  const detail = selected ? summarizeIssueStatusNote(issue.statusNote) : undefined;
  const session = sessionDisplay(issue);
  const facts = buildFacts(issue, selected);
  const blocker = selected ? blockerText(issue) : null;
  const isTerminal = TERMINAL_STATES.has(effectiveState(issue));

  if (isTerminal && !selected) {
    return 1;
  }

  const line1Parts = [
    `${selected ? "\u25b8" : " "} ${key}`,
    relativeTime(issue.updatedAt).padStart(4),
    session.label,
    ...facts.map((fact) => fact.text),
  ];
  let rows = measureRenderedTextRows(line1Parts.join(" · "), width);

  if (title) rows += measureRenderedTextRows(title, Math.max(8, width - 2));
  if (blocker) rows += measureRenderedTextRows(blocker, Math.max(8, width - 2));
  if (detail) rows += measureRenderedTextRows(detail, Math.max(8, width - 4));
  if (selected && issue.factoryState && issue.sessionState) rows += 1;
  if (detail) rows += 1;

  return Math.max(1, rows);
}
