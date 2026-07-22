import type { IssueRecord } from "./db-types.ts";
import { deriveAuthority, deriveWorkflowContext } from "./workflow-observation-context.ts";
import { deriveWorkflowTasks } from "./workflow-task-derivation.ts";
import type { WorkflowArtifact, WorkflowProjectionInput, WorkflowSnapshot } from "./workflow-model.ts";

function issueStatus(issue: IssueRecord, blockerCount: number): WorkflowSnapshot["status"] {
  if (issue.activeRunId !== undefined) return "running";
  if (
    issue.workflowOutcome === "completed"
    || issue.prState === "merged"
    || issue.currentLinearStateType === "completed"
    || issue.currentLinearState?.trim().toLowerCase() === "done"
  ) return "done";
  if (issue.workflowOutcome === "failed" || issue.workflowOutcome === "escalated") return "failed";
  if (issue.currentLinearStateType === "canceled" || issue.currentLinearStateType === "cancelled") return "failed";
  if (!issue.delegatedToPatchRelay || issue.inputRequestKind || blockerCount > 0) return "waiting";
  return "idle";
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
