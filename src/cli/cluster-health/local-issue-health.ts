import { ACTIVE_RUN_STATES } from "../../factory-state.ts";
import type { IssueDependencyRecord, IssueRecord } from "../../db-types.ts";
import { isUndelegatedPausedNoPrWork } from "../../paused-issue-state.ts";
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

export function needsReviewAutomation(issue: IssueRecord): boolean {
  if (issue.factoryState === "awaiting_queue" || !isActiveWorkflowIssue(issue)) {
    return false;
  }
  return hasOpenPr(issue.prNumber, issue.prState);
}

export function isActiveWorkflowIssue(issue: IssueRecord): boolean {
  return issue.factoryState !== "done" && !isTerminalFailureIssue(issue);
}

export function isTerminalFailureIssue(issue: IssueRecord): boolean {
  return issue.factoryState === "failed" || issue.factoryState === "escalated";
}

export function evaluateTerminalIssueHealth(issue: IssueRecord): ClusterHealthCheck | undefined {
  if (issue.factoryState === "failed" || issue.factoryState === "escalated") {
    return {
      status: "warn",
      scope: "issue:terminal",
      message: `Historical terminal issue is in failure state ${issue.factoryState}`,
    };
  }
  return undefined;
}

export function evaluateLocalIssueHealth(snapshot: IssueSnapshot): ClusterHealthCheck | undefined {
  const { issue, session, missingTrackedBlockers, blockedBy, ageMs, readyForExecution } = snapshot;
  const pausedNoPrWork = isUndelegatedPausedNoPrWork(issue);
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

  if (readyForExecution && issue.activeRunId === undefined && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      status: "fail",
      scope: "issue:dispatch",
      message: "Issue is ready for execution but no active run has started",
    };
  }

  if (!pausedNoPrWork && ACTIVE_RUN_STATES.has(issue.factoryState) && issue.activeRunId === undefined && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      status: "fail",
      scope: "issue:dispatch",
      message: `Issue is parked in ${issue.factoryState} without an active run`,
    };
  }

  if (!pausedNoPrWork && issue.factoryState === "delegated" && issue.activeRunId === undefined && !readyForExecution && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      status: "fail",
      scope: "issue:dispatch",
      message: "Delegated issue is idle but no wake is queued",
    };
  }

  if (issue.factoryState === "awaiting_input" && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      status: "warn",
      scope: "issue:operator",
      message: "Issue is waiting on operator input",
    };
  }

  if (issue.factoryState === "awaiting_queue" && ageMs >= DOWNSTREAM_STALE_MS) {
    return {
      status: "warn",
      scope: "issue:downstream",
      message: "Issue has been waiting on downstream merge automation for a long time",
    };
  }

  return undefined;
}
