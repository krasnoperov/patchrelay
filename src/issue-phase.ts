import type { IssueRecord } from "./db-types.ts";
import type { RunType } from "./run-type.ts";

export type WorkflowOutcome = "completed" | "failed" | "escalated";
export type InputRequestKind = "paused_local_work" | "completion_check_question";

export type IssuePhase =
  | "delegated"
  | "implementing"
  | "pr_open"
  | "changes_requested"
  | "repairing_ci"
  | "awaiting_queue"
  | "repairing_queue"
  | "deploying"
  | "awaiting_input"
  | "paused"
  | "done"
  | "failed"
  | "escalated";

export interface IssuePhaseInput extends Pick<IssueRecord,
  | "delegatedToPatchRelay"
  | "workflowOutcome"
  | "inputRequestKind"
  | "activeRunId"
  | "prNumber"
  | "prState"
  | "prIsDraft"
  | "prReviewState"
  | "prCheckStatus"
  | "lastGitHubFailureSource"
  | "deployStartedAt"
> {
  activeRunType?: RunType | undefined;
  runnableTaskRunType?: RunType | undefined;
}

/**
 * Operator-facing phase derived only from durable workflow facts.
 *
 * This value is never persisted and must never be used for executor admission.
 */
export function deriveIssuePhase(input: IssuePhaseInput): IssuePhase {
  if (input.workflowOutcome === "completed") return "done";
  if (input.workflowOutcome === "failed") return "failed";
  if (input.workflowOutcome === "escalated") return "escalated";
  if (input.inputRequestKind) return "awaiting_input";

  const runType = input.activeRunType
    ?? input.runnableTaskRunType
    ?? (input.activeRunId !== undefined ? "implementation" : undefined);
  if (runType === "ci_repair") return "repairing_ci";
  if (runType === "queue_repair") return "repairing_queue";
  if (runType === "review_fix" || runType === "branch_upkeep") return "changes_requested";
  if (runType === "implementation") return "implementing";

  if (!input.delegatedToPatchRelay) return "paused";
  if (input.prState === "merged") return input.deployStartedAt ? "deploying" : "done";

  const hasOpenPr = input.prNumber !== undefined && (input.prState === undefined || input.prState === "open");
  if (hasOpenPr && !input.prIsDraft) {
    if (input.lastGitHubFailureSource === "queue_eviction") return "repairing_queue";
    if (input.lastGitHubFailureSource === "branch_ci" || input.prCheckStatus === "failed" || input.prCheckStatus === "failure") {
      return "repairing_ci";
    }
    if (input.prReviewState === "changes_requested") return "changes_requested";
    if (input.prReviewState === "approved") return "awaiting_queue";
    return "pr_open";
  }

  return runType ? "implementing" : "delegated";
}
