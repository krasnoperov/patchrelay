import { deriveIssueTerminalOutcome } from "./issue-execution-state.ts";
import type { InputRequestKind, IssuePhase, WorkflowOutcome } from "./issue-phase.ts";

export interface PrDisplayIssueLike {
  prNumber?: number | undefined;
  prState?: string | undefined;
  workflowOutcome?: WorkflowOutcome | undefined;
  inputRequestKind?: InputRequestKind | undefined;
  currentLinearState?: string | undefined;
  currentLinearStateType?: string | undefined;
  delegatedToPatchRelay?: boolean | undefined;
  phase?: IssuePhase | undefined;
}

export type PrDisplayContext =
  | { kind: "no_pr" }
  | { kind: "active_pr"; prNumber: number }
  | { kind: "merged_pr"; prNumber: number }
  | { kind: "closed_historical_pr"; prNumber: number }
  | { kind: "closed_replacement_pending"; prNumber: number }
  | { kind: "closed_pr_paused"; prNumber: number };

export function derivePrDisplayContext(issue: PrDisplayIssueLike): PrDisplayContext {
  if (issue.prNumber === undefined) {
    return { kind: "no_pr" };
  }

  if (issue.prState === "merged") {
    return { kind: "merged_pr", prNumber: issue.prNumber };
  }

  if (issue.prState === "closed") {
    if (
      issue.phase === "done"
      || issue.phase === "failed"
      || issue.phase === "escalated"
      || deriveIssueTerminalOutcome(issue) !== undefined
    ) {
      return { kind: "closed_historical_pr", prNumber: issue.prNumber };
    }
    if (issue.delegatedToPatchRelay === false) {
      return { kind: "closed_pr_paused", prNumber: issue.prNumber };
    }
    return { kind: "closed_replacement_pending", prNumber: issue.prNumber };
  }

  return { kind: "active_pr", prNumber: issue.prNumber };
}
