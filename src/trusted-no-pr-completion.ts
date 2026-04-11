import type { IssueRecord, RunRecord } from "./db-types.ts";

export function hasTrustedNoPrCompletion(
  issue: Pick<IssueRecord, "factoryState" | "prNumber" | "prUrl">,
  latestRun: Pick<RunRecord, "status" | "completionCheckOutcome"> | undefined,
): boolean {
  return issue.factoryState === "done"
    && issue.prNumber === undefined
    && !issue.prUrl
    && latestRun?.status === "completed"
    && latestRun.completionCheckOutcome === "done";
}
