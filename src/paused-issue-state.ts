import type { IssueRecord, RunRecord } from "./db-types.ts";
import { resolveAwaitingInputReason } from "./awaiting-input-reason.ts";

export function isUndelegatedPausedIssue(issue: { delegatedToPatchRelay?: boolean | undefined; factoryState?: string | undefined }): boolean {
  return issue.delegatedToPatchRelay === false
    && issue.factoryState !== "done"
    && issue.factoryState !== "failed"
    && issue.factoryState !== "escalated";
}

export function isUndelegatedPausedNoPrWork(
  issue: { delegatedToPatchRelay?: boolean | undefined; factoryState?: string | undefined; prNumber?: number | undefined },
): boolean {
  return isUndelegatedPausedIssue(issue)
    && issue.prNumber === undefined
    && (issue.factoryState === "delegated" || issue.factoryState === "implementing");
}

export function isResumablePausedLocalWork(params: {
  issue: Pick<IssueRecord, "delegatedToPatchRelay" | "factoryState" | "prNumber">;
  latestRun?: RunRecord | undefined;
}): boolean {
  if (params.issue.delegatedToPatchRelay === false) {
    return false;
  }
  if (params.issue.prNumber !== undefined) {
    return false;
  }
  if (params.issue.factoryState === "delegated" || params.issue.factoryState === "implementing") {
    return true;
  }
  return resolveAwaitingInputReason(params) === "paused_local_work";
}
