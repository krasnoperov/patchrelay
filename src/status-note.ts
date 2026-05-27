import { extractCompletionCheck } from "./completion-check.ts";
import type { IssueRecord, IssueSessionEventRecord, RunRecord } from "./db-types.ts";
import { extractLatestAssistantSummary } from "./issue-session-events.ts";
import { sanitizeOperatorFacingText } from "./presentation-text.ts";

function clean(value: string | undefined): string | undefined {
  return sanitizeOperatorFacingText(value);
}

function eventStatusNote(event: IssueSessionEventRecord | undefined): string | undefined {
  if (!event) return undefined;
  const payload = event.eventJson ? parseEventJson(event.eventJson) : undefined;
  const dirtySummary = typeof payload?.summary === "string" && payload.dirtyWorktree === true
    ? payload.summary
    : undefined;
  switch (event.eventType) {
    case "stop_requested":
      if (dirtySummary) return `Operator stopped the run with dirty worktree: ${dirtySummary}. Use retry or delegate again to resume.`;
      return "Operator stopped the run. Use retry or delegate again to resume.";
    case "undelegated":
      if (dirtySummary) return `Issue was un-delegated from PatchRelay with dirty worktree: ${dirtySummary}`;
      return "Issue was un-delegated from PatchRelay. Delegate it again to resume.";
    case "issue_removed":
      return "Issue was removed from Linear.";
    case "pr_closed":
      return "Pull request was closed without merging.";
    case "pr_merged":
      return "Pull request merged successfully.";
    default:
      return undefined;
  }
}

function parseEventJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function deriveIssueStatusNote(params: {
  issue: Pick<IssueRecord, "factoryState">;
  sessionSummary?: string | undefined;
  latestRun?: RunRecord | undefined;
  latestEvent?: IssueSessionEventRecord | undefined;
  failureSummary?: string | undefined;
  blockedByKeys?: string[] | undefined;
  waitingReason?: string | undefined;
}): string | undefined {
  const blockedByKeys = (params.blockedByKeys ?? []).filter((value) => value.trim().length > 0);
  if (blockedByKeys.length > 0) {
    return `Blocked by ${blockedByKeys.join(", ")}`;
  }

  const sessionSummary = clean(params.sessionSummary);
  const completionCheckActive = Boolean(
    params.latestRun?.status === "running"
      && params.latestRun.completionCheckThreadId
      && !params.latestRun.completionCheckOutcome,
  );
  const completionCheck = extractCompletionCheck(params.latestRun);
  const completionCheckNote = clean(
    completionCheck?.outcome === "needs_input"
      ? completionCheck.question ?? completionCheck.summary
      : completionCheck?.summary,
  );
  const latestRunNote = clean(extractLatestAssistantSummary(params.latestRun));
  const latestFailureReason = clean(params.latestRun?.failureReason);
  const latestEventNote = clean(eventStatusNote(params.latestEvent));
  const failureSummary = clean(params.failureSummary);
  const waitingReason = clean(params.waitingReason);

  let note: string | undefined;
  if (completionCheckActive) {
    note = "No PR found; checking next step";
  } else {
    switch (params.issue.factoryState) {
      case "awaiting_input":
        note = completionCheckNote ?? latestRunNote ?? latestEventNote ?? sessionSummary;
        break;
      case "failed":
      case "escalated":
        note = latestEventNote ?? completionCheckNote ?? failureSummary ?? latestFailureReason ?? latestRunNote ?? sessionSummary;
        break;
      case "done":
        note = completionCheckNote ?? sessionSummary ?? latestRunNote ?? failureSummary;
        break;
      case "repairing_ci":
      case "repairing_queue":
        note = failureSummary ?? sessionSummary ?? latestRunNote;
        break;
      default:
        note = latestEventNote ?? sessionSummary ?? latestRunNote ?? failureSummary;
        break;
    }
  }

  if (!note) return undefined;
  if (waitingReason && note === waitingReason) return undefined;
  return note;
}
