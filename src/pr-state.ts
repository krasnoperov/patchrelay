import type { InputRequestKind, WorkflowOutcome } from "./issue-phase.ts";
import { isCanceledLinearState, isCompletedLinearState } from "./linear-state.ts";
export { isCanceledLinearState, isCompletedLinearState, isTerminalLinearState } from "./linear-state.ts";
export { hasOpenPr, isClosedPrState, isOpenPrState } from "./pr-lifecycle.ts";

export interface PrLifecycleIssueLike {
  prNumber?: number | undefined;
  prState?: string | undefined;
  currentLinearState?: string | undefined;
  currentLinearStateType?: string | undefined;
  workflowOutcome?: WorkflowOutcome | undefined;
  inputRequestKind?: InputRequestKind | undefined;
}

export function isIssueCompleted(issue: Pick<PrLifecycleIssueLike, "currentLinearStateType" | "currentLinearState" | "workflowOutcome">): boolean {
  return issue.workflowOutcome === "completed"
    || isCompletedLinearState(issue.currentLinearStateType, issue.currentLinearState);
}

export function isIssueTerminal(issue: Pick<PrLifecycleIssueLike, "workflowOutcome" | "inputRequestKind">): boolean {
  return issue.workflowOutcome !== undefined || issue.inputRequestKind !== undefined;
}

export function resolveClosedPrDisposition(issue: Pick<PrLifecycleIssueLike,
  "currentLinearStateType" | "currentLinearState" | "workflowOutcome" | "inputRequestKind"
>): "done" | "terminal" | "redelegate" {
  if (isIssueCompleted(issue)) return "done";
  if (issue.workflowOutcome === "failed" || issue.workflowOutcome === "escalated" || issue.inputRequestKind) return "terminal";
  if (isCanceledLinearState(issue.currentLinearStateType, issue.currentLinearState)) return "terminal";
  return "redelegate";
}

export function buildClosedPrCleanupFields() {
  return {
    prReviewState: null,
    prCheckStatus: null,
    lastBlockingReviewHeadSha: null,
    lastGitHubCiSnapshotHeadSha: null,
    lastGitHubCiSnapshotGateCheckName: null,
    lastGitHubCiSnapshotGateCheckStatus: null,
    lastGitHubCiSnapshotJson: null,
    lastGitHubCiSnapshotSettledAt: null,
  };
}
