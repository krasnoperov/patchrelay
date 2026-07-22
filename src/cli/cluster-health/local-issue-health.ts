import type { IssueDependencyRecord, IssueRecord } from "../../db-types.ts";
import { isIssueDoneProjection, isIssueTerminalFailureProjection } from "../../issue-execution-state.ts";
import { hasOpenPr } from "../../pr-state.ts";
import { DOWNSTREAM_STALE_MS, RECONCILIATION_GRACE_MS } from "./shared.ts";
import type { ClusterHealthCheck, IssueSnapshot } from "./types.ts";

export function isResolvedDependency(dep: IssueDependencyRecord): boolean {
  const stateType = dep.blockerCurrentLinearStateType?.trim().toLowerCase();
  const state = dep.blockerCurrentLinearState?.trim().toLowerCase();
  return stateType === "completed"
    || stateType === "canceled"
    || stateType === "cancelled"
    || state === "done"
    || state === "canceled"
    || state === "cancelled";
}

export function needsReviewAutomation(snapshot: IssueSnapshot): boolean {
  if (
    snapshot.executionState.kind === "idle_awaiting_external"
    && (snapshot.executionState.waitingOn === "merge_queue" || snapshot.executionState.waitingOn === "downstream_automation")
  ) {
    return false;
  }
  if (snapshot.executionState.kind === "terminal" || snapshot.executionState.kind === "undelegated") {
    return false;
  }
  return hasOpenPr(snapshot.issue.prNumber, snapshot.issue.prState);
}

export function isActiveWorkflowIssue(issue: IssueRecord): boolean {
  return !isIssueDoneProjection(issue) && !isTerminalFailureIssue(issue);
}

export function isTerminalFailureIssue(issue: IssueRecord): boolean {
  return isIssueTerminalFailureProjection(issue);
}

export function evaluateTerminalIssueHealth(issue: IssueRecord): ClusterHealthCheck | undefined {
  if (isIssueTerminalFailureProjection(issue)) {
    return {
      status: "warn",
      scope: "issue:terminal",
      message: `Historical terminal issue has outcome ${issue.workflowOutcome ?? "failed"}`,
    };
  }
  return undefined;
}

export function evaluateLocalIssueHealth(snapshot: IssueSnapshot): ClusterHealthCheck | undefined {
  const { issue, session, missingTrackedBlockers, blockedBy, ageMs, executionState } = snapshot;
  if (missingTrackedBlockers.length > 0) {
    return {
      status: "fail",
      scope: "issue:blockers",
      message: `Blocked by unmanaged issue${missingTrackedBlockers.length === 1 ? "" : "s"} ${missingTrackedBlockers.map((dep) => dep.blockerIssueKey ?? dep.blockerLinearIssueId).join(", ")}`,
    };
  }

  if (issue.activeRunId !== undefined && session?.sessionState !== "running") {
    return {
      status: "fail",
      scope: "issue:run-state",
      message: `Issue has active run #${issue.activeRunId} but session state is ${session?.sessionState ?? "missing"}`,
    };
  }

  if (issue.activeRunId === undefined && session?.sessionState === "running") {
    return {
      status: "fail",
      scope: "issue:run-state",
      message: "Issue session is marked running but no active run is attached",
    };
  }

  if (blockedBy.length > 0) {
    return undefined;
  }

  if (executionState.kind === "ready" && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      status: "fail",
      scope: "issue:dispatch",
      message: "Issue is ready for execution but no active run has started",
    };
  }

  if (executionState.kind === "awaiting_followup" && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      status: "fail",
      scope: "issue:dispatch",
      message: `Issue owes ${executionState.followup} work but no runnable workflow task is queued`,
    };
  }

  if (
    executionState.kind === "idle"
    && issue.delegatedToPatchRelay !== false
    && !hasOpenPr(issue.prNumber, issue.prState)
    && ageMs >= RECONCILIATION_GRACE_MS
  ) {
    return {
      status: "fail",
      scope: "issue:dispatch",
      message: "Delegated issue is idle but no workflow task is queued",
    };
  }

  if (executionState.kind === "waiting_input" && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      status: "warn",
      scope: "issue:operator",
      message: "Issue is waiting on operator input",
    };
  }

  if (
    executionState.kind === "idle_awaiting_external"
    && (executionState.waitingOn === "merge_queue" || executionState.waitingOn === "downstream_automation")
    && ageMs >= DOWNSTREAM_STALE_MS
  ) {
    return {
      status: "warn",
      scope: "issue:downstream",
      message: "Issue has been waiting on downstream merge automation for a long time",
    };
  }

  return undefined;
}
