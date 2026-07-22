import type { IssueRecord, RunRecord } from "./db-types.ts";
import { resolveAwaitingInputReason } from "./awaiting-input-reason.ts";
import { deriveIssueExecutionState, isIssueLocalWorkProjection } from "./issue-execution-state.ts";

export function isUndelegatedPausedIssue(issue: { delegatedToPatchRelay?: boolean | undefined; workflowOutcome?: "completed" | "failed" | "escalated" | undefined }): boolean {
  return deriveIssueExecutionState({
    delegatedToPatchRelay: issue.delegatedToPatchRelay,
    workflowOutcome: issue.workflowOutcome,
  }).kind === "undelegated";
}

export function isUndelegatedPausedNoPrWork(
  issue: { delegatedToPatchRelay?: boolean | undefined; workflowOutcome?: "completed" | "failed" | "escalated" | undefined; prNumber?: number | undefined },
): boolean {
  return isUndelegatedPausedIssue(issue)
    && issue.prNumber === undefined
    && isIssueLocalWorkProjection(issue);
}

export function isResumablePausedLocalWork(params: {
  issue: Pick<IssueRecord, "delegatedToPatchRelay" | "workflowOutcome" | "inputRequestKind" | "prNumber">;
  latestRun?: RunRecord | undefined;
}): boolean {
  if (params.issue.delegatedToPatchRelay === false) {
    return false;
  }
  if (params.issue.prNumber !== undefined) {
    return false;
  }
  if (params.issue.inputRequestKind === "completion_check_question") {
    return false;
  }
  if (isIssueLocalWorkProjection(params.issue)) {
    return true;
  }
  return resolveAwaitingInputReason(params) === "paused_local_work";
}
