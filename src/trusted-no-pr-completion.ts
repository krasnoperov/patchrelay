import type { IssueRecord, RunRecord } from "./db-types.ts";
import { isIssueDoneProjection } from "./issue-execution-state.ts";

export function hasTrustedNoPrCompletion(
  issue: Pick<IssueRecord, "factoryState" | "prNumber" | "prUrl">,
  latestRun: Pick<RunRecord, "status" | "completionCheckOutcome"> | undefined,
): boolean {
  return isIssueDoneProjection(issue)
    && issue.prNumber === undefined
    && !issue.prUrl
    && latestRun?.status === "completed"
    && latestRun.completionCheckOutcome === "done";
}
