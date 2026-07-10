import type { IssueRecord } from "./db-types.ts";
import { deriveIssueExecutionState, deriveIssueTerminalOutcome } from "./issue-execution-state.ts";
import { deriveAuthority, deriveWorkflowContext } from "./workflow-observation-context.ts";
import { deriveWorkflowTasks } from "./workflow-task-derivation.ts";
import type { WorkflowArtifact, WorkflowProjectionInput, WorkflowSnapshot } from "./workflow-model.ts";

function issueStatus(issue: IssueRecord, blockerCount: number): WorkflowSnapshot["status"] {
  if (issue.activeRunId !== undefined) return "running";
  const terminalOutcome = deriveIssueTerminalOutcome(issue);
  if (terminalOutcome === "done") return "done";
  if (terminalOutcome === "failed" || terminalOutcome === "escalated") return "failed";

  const executionState = deriveIssueExecutionState({
    delegatedToPatchRelay: issue.delegatedToPatchRelay,
    factoryState: issue.factoryState,
    currentLinearState: issue.currentLinearState,
    currentLinearStateType: issue.currentLinearStateType,
    prNumber: issue.prNumber,
    prState: issue.prState,
    prHeadSha: issue.prHeadSha,
    prReviewState: issue.prReviewState,
    prCheckStatus: issue.prCheckStatus,
    lastBlockingReviewHeadSha: issue.lastBlockingReviewHeadSha,
    latestFailureCheckName: issue.lastGitHubFailureCheckName,
    blockedByKeys: blockerCount > 0 ? ["__workflow_blocker__"] : [],
  });

  switch (executionState.kind) {
    case "running":
    case "inconsistent":
      return "running";
    case "terminal":
      return executionState.outcome === "done" ? "done" : "failed";
    case "undelegated":
    case "settling":
    case "blocked":
    case "waiting_input":
      return "waiting";
    case "awaiting_followup":
    case "idle_awaiting_external":
    case "ready":
    case "idle":
      return "idle";
  }
}

function issueArtifacts(issue: IssueRecord): WorkflowArtifact[] {
  const artifacts: WorkflowArtifact[] = [];
  if (issue.branchName) {
    artifacts.push({ type: "branch", ref: issue.branchName });
  }
  if (issue.prNumber !== undefined) {
    artifacts.push({
      type: "pr",
      ref: String(issue.prNumber),
      ...(issue.prState ? { state: issue.prState } : {}),
      metadata: {
        ...(issue.prUrl ? { url: issue.prUrl } : {}),
        ...(issue.prHeadSha ? { headSha: issue.prHeadSha } : {}),
        ...(issue.prReviewState ? { reviewState: issue.prReviewState } : {}),
        ...(issue.prCheckStatus ? { checkStatus: issue.prCheckStatus } : {}),
        ...(issue.prIsDraft ? { isDraft: true } : {}),
      },
    });
  }
  if (issue.threadId) {
    artifacts.push({ type: "codex_thread", ref: issue.threadId });
  }
  if (issue.agentSessionId) {
    artifacts.push({ type: "linear_session", ref: issue.agentSessionId });
  }
  return artifacts;
}

export function projectWorkflowSnapshot(input: WorkflowProjectionInput): WorkflowSnapshot {
  const observations = input.observations ?? [];
  const blockerCount = input.blockerCount ?? 0;
  const childCount = input.childCount ?? 0;
  const openChildCount = input.openChildCount ?? childCount;
  const authority = deriveAuthority(input.issue, observations);
  const baseSnapshot: Omit<WorkflowSnapshot, "openTasks"> = {
    id: `${input.issue.projectId}:${input.issue.linearIssueId}`,
    projectId: input.issue.projectId,
    subjectId: input.issue.linearIssueId,
    status: input.activeRun ? "running" : issueStatus({ ...input.issue, delegatedToPatchRelay: authority.delegated }, blockerCount),
    authority,
    context: deriveWorkflowContext(input.issue, observations),
    ...(input.activeRun
      ? { activeRun: input.activeRun }
      : input.issue.activeRunId !== undefined
      ? {
          activeRun: {
            id: input.issue.activeRunId,
            runType: "implementation",
            authorityEpoch: authority.epoch,
            status: "running",
          },
        }
      : {}),
    artifacts: issueArtifacts(input.issue),
    blockerCount,
    childCount,
    openChildCount,
  };
  return {
    ...baseSnapshot,
    openTasks: deriveWorkflowTasks(baseSnapshot),
  };
}
