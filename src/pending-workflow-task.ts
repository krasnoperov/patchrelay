import type { WorkflowTaskStore } from "./db/workflow-task-store.ts";
import type { RunType } from "./run-type.ts";

// "Pending runnable work" means one thing: an open runnable workflow task exists.
// Session events are inbox/audit facts. They are not scheduler inputs unless
// task reconciliation turns them into open workflow_tasks.
export interface PendingWorkflowTaskStores {
  workflowTasks: Pick<WorkflowTaskStore, "listOpenRunnableTasks">;
}

export function peekRunnableWorkflowTaskRunType(
  stores: PendingWorkflowTaskStores,
  projectId: string,
  linearIssueId: string,
): RunType | undefined {
  const runnableTask = stores.workflowTasks
    .listOpenRunnableTasks(projectId)
    .find((task) => task.subjectId === linearIssueId);
  return runnableTask?.runType;
}

export function hasRunnableWorkflowTask(
  stores: PendingWorkflowTaskStores,
  projectId: string,
  linearIssueId: string,
): boolean {
  const hasRunnableTask = stores.workflowTasks
    .listOpenRunnableTasks(projectId)
    .some((task) => task.subjectId === linearIssueId);
  return hasRunnableTask;
}
