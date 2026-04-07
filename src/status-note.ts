import type { IssueRecord, IssueSessionEventRecord, RunRecord } from "./db-types.ts";
import { extractLatestAssistantSummary } from "./issue-session-events.ts";

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function eventStatusNote(event: IssueSessionEventRecord | undefined): string | undefined {
  if (!event) return undefined;
  switch (event.eventType) {
    case "stop_requested":
      return "Operator stopped the run. Use retry or delegate again to resume.";
    case "undelegated":
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
  const latestRunNote = clean(extractLatestAssistantSummary(params.latestRun));
  const latestEventNote = clean(eventStatusNote(params.latestEvent));
  const failureSummary = clean(params.failureSummary);
  const waitingReason = clean(params.waitingReason);

  let note: string | undefined;
  switch (params.issue.factoryState) {
    case "awaiting_input":
      note = latestRunNote ?? latestEventNote ?? sessionSummary;
      break;
    case "failed":
    case "escalated":
      note = latestEventNote ?? failureSummary ?? latestRunNote ?? sessionSummary;
      break;
    case "repairing_ci":
    case "repairing_queue":
      note = failureSummary ?? sessionSummary ?? latestRunNote;
      break;
    default:
      note = sessionSummary ?? latestRunNote ?? failureSummary;
      break;
  }

  if (!note) return undefined;
  if (waitingReason && note === waitingReason) return undefined;
  return note;
}
