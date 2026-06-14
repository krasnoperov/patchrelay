import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { GateDecision, WorkflowTask } from "./workflow-runtime.ts";
import {
  evaluateTaskStart,
  projectWorkflowSnapshot,
  type WorkflowSnapshot,
} from "./workflow-runtime.ts";

function isActiveRun(run: Pick<RunRecord, "status">): boolean {
  return run.status === "queued" || run.status === "running";
}

function resolveActiveRunSnapshot(
  db: PatchRelayDatabase,
  issue: IssueRecord,
  options?: { ignoreDetachedActiveRuns?: boolean | undefined },
): WorkflowSnapshot["activeRun"] {
  const pinnedRun = issue.activeRunId !== undefined ? db.runs.getRunById(issue.activeRunId) : undefined;
  if (pinnedRun && isActiveRun(pinnedRun)) {
    return {
      id: pinnedRun.id,
      runType: pinnedRun.runType,
      authorityEpoch: pinnedRun.authorityEpoch,
      status: pinnedRun.status,
    };
  }
  if (options?.ignoreDetachedActiveRuns) return undefined;
  const run = db.runs.listRunsForIssue(issue.projectId, issue.linearIssueId)
      .filter(isActiveRun)
      .at(-1);
  if (!run) return undefined;
  return {
    id: run.id,
    runType: run.runType,
    authorityEpoch: run.authorityEpoch,
    status: run.status,
  };
}

export interface WorkflowTaskReconciliation {
  snapshot: WorkflowSnapshot;
  result: ReturnType<PatchRelayDatabase["workflowTasks"]["reconcileTasks"]>;
}

function readinessForTask(snapshot: WorkflowSnapshot, task: WorkflowTask): GateDecision {
  if (task.type === "wait") {
    return { action: "wait", reason: task.reason };
  }
  if (task.type === "ask") {
    return {
      action: "ask",
      reason: task.reason,
      question: typeof task.requirements?.question === "string" ? task.requirements.question : task.reason,
    };
  }
  if (task.type === "escalate") {
    return { action: "escalate", reason: task.reason };
  }
  return evaluateTaskStart(snapshot, task);
}

export function buildWorkflowSnapshotForIssue(
  db: PatchRelayDatabase,
  issue: IssueRecord,
  options?: { ignoreDetachedActiveRuns?: boolean | undefined },
): WorkflowSnapshot {
  const activeRun = resolveActiveRunSnapshot(db, issue, options);
  return projectWorkflowSnapshot({
    issue,
    observations: db.workflowObservations.listObservations(issue.projectId, issue.linearIssueId),
    blockerCount: db.issues.countUnresolvedBlockers(issue.projectId, issue.linearIssueId),
    childCount: db.issues.listCanonicalChildIssues(issue.projectId, issue.linearIssueId).length,
    openChildCount: db.issues.countOpenChildIssues(issue.projectId, issue.linearIssueId),
    ...(activeRun ? { activeRun } : {}),
  });
}

export function reconcileWorkflowTasksForIssue(
  db: PatchRelayDatabase,
  issue: IssueRecord,
  options?: { ignoreDetachedActiveRuns?: boolean | undefined },
): WorkflowTaskReconciliation {
  const snapshot = buildWorkflowSnapshotForIssue(db, issue, options);
  const result = db.workflowTasks.reconcileTasks({
    projectId: issue.projectId,
    subjectId: issue.linearIssueId,
    tasks: snapshot.openTasks.map((task) => {
      const decision = readinessForTask(snapshot, task);
      return {
        task,
        authorityEpoch: snapshot.authority.epoch,
        gateAction: decision.action,
        ...("reason" in decision ? { gateReason: decision.reason } : {}),
      };
    }),
  });
  return { snapshot, result };
}
