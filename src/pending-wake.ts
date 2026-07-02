import type { IssueSessionStore } from "./db/issue-session-store.ts";
import type { WorkflowTaskStore } from "./db/workflow-task-store.ts";
import type { RunType } from "./run-type.ts";

// After the implicit derived-wake rung was deleted (S3), "does this issue have
// pending wake work?" is a single predicate: an open runnable workflow task
// exists for it, OR an actionable session-event wake is derivable. Every
// reconciled wake the old implicit resolver could derive (ci_repair,
// queue_repair, branch_upkeep, review_fix) is now a `run:*` workflow task from
// the same issue columns, so the task rung fully covers it. The legacy
// `pending_run_type` column is handled by its own readers (retired in S7).
export interface PendingWakeStores {
  workflowTasks: Pick<WorkflowTaskStore, "listOpenRunnableTasks">;
  issueSessions: Pick<IssueSessionStore, "peekIssueSessionWake">;
}

export function peekPendingWakeRunType(
  stores: PendingWakeStores,
  projectId: string,
  linearIssueId: string,
): RunType | undefined {
  const runnableTask = stores.workflowTasks
    .listOpenRunnableTasks(projectId)
    .find((task) => task.subjectId === linearIssueId);
  if (runnableTask?.runType) return runnableTask.runType;
  return stores.issueSessions.peekIssueSessionWake(projectId, linearIssueId)?.runType;
}

export function hasPendingWake(
  stores: PendingWakeStores,
  projectId: string,
  linearIssueId: string,
): boolean {
  const hasRunnableTask = stores.workflowTasks
    .listOpenRunnableTasks(projectId)
    .some((task) => task.subjectId === linearIssueId);
  return hasRunnableTask
    || stores.issueSessions.peekIssueSessionWake(projectId, linearIssueId) !== undefined;
}
