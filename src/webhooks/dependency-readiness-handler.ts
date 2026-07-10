import type { PatchRelayDatabase } from "../db.ts";
import { emitTelemetry, noopTelemetry, type PatchRelayTelemetry } from "../telemetry.ts";
import type { WorkflowTaskDispatcher } from "../workflow-task-dispatcher.ts";
import { peekRunnableWorkflowTaskRunType } from "../pending-workflow-task.ts";
import { reconcileWorkflowTasksForIssue } from "../workflow-task-reconciler.ts";
import { isIssueLocalWorkProjection } from "../issue-execution-state.ts";

export class DependencyReadinessHandler {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly workflowTaskDispatcher: WorkflowTaskDispatcher,
    private readonly telemetry: PatchRelayTelemetry = noopTelemetry,
  ) {}

  reconcile(projectId: string, blockerLinearIssueId: string): string[] {
    const newlyReady: string[] = [];
    for (const dependent of this.db.issues.listDependents(projectId, blockerLinearIssueId)) {
      const issue = this.db.issues.getIssue(projectId, dependent.linearIssueId);
      if (!issue) {
        continue;
      }

      const unresolved = this.db.issues.countUnresolvedBlockers(projectId, dependent.linearIssueId);
      if (unresolved > 0) {
        const blockerKeys = this.unresolvedBlockerKeys(projectId, dependent.linearIssueId);
        emitTelemetry(this.telemetry, {
          type: "dependency.remaining_blockers",
          projectId,
          linearIssueId: dependent.linearIssueId,
          ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
          blockerLinearIssueId,
          blockerCount: unresolved,
          blockerKeys,
        });
        emitTelemetry(this.telemetry, {
          type: "dependency.dependent_blocked",
          projectId,
          linearIssueId: dependent.linearIssueId,
          ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
          blockerLinearIssueId,
          blockerCount: unresolved,
          blockerKeys,
        });
        continue;
      }

      if (!issue.delegatedToPatchRelay || issue.activeRunId !== undefined) {
        continue;
      }

      const workflowReconciliation = reconcileWorkflowTasksForIssue(this.db, issue);
      const hasRunnableWorkflowTask = [
        ...workflowReconciliation.result.opened,
        ...workflowReconciliation.result.updated,
      ].some((task) => task.gateAction === "start" && task.runType);
      const runnableTaskRunType = peekRunnableWorkflowTaskRunType(this.db, projectId, dependent.linearIssueId);
      if (runnableTaskRunType) {
        const dispatchedRunType = this.workflowTaskDispatcher.dispatchIfWorkflowTaskPending(projectId, dependent.linearIssueId);
        emitTelemetry(this.telemetry, {
          type: "dependency.dependent_unblocked",
          projectId,
          linearIssueId: dependent.linearIssueId,
          ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
          blockerLinearIssueId,
          ...(dispatchedRunType ? { dispatchedRunType } : {}),
        });
        newlyReady.push(dependent.linearIssueId);
        continue;
      }

      if (hasRunnableWorkflowTask) {
        const dispatchedRunType = this.workflowTaskDispatcher.dispatchIfWorkflowTaskPending(projectId, dependent.linearIssueId);
        emitTelemetry(this.telemetry, {
          type: "dependency.dependent_unblocked",
          projectId,
          linearIssueId: dependent.linearIssueId,
          ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
          blockerLinearIssueId,
          ...(dispatchedRunType ? { dispatchedRunType } : {}),
        });
        newlyReady.push(dependent.linearIssueId);
        continue;
      }

      if (!isIssueLocalWorkProjection(issue) || this.db.issueSessions.hasPendingIssueSessionEvents(projectId, dependent.linearIssueId)) {
        continue;
      }
    }

    return newlyReady;
  }

  private unresolvedBlockerKeys(projectId: string, linearIssueId: string): string[] {
    return this.db.issues.listIssueDependencies(projectId, linearIssueId)
      .filter((entry) => entry.blockerCurrentLinearStateType !== "completed"
        && entry.blockerCurrentLinearState?.trim().toLowerCase() !== "done")
      .map((entry) => entry.blockerIssueKey ?? entry.blockerLinearIssueId);
  }
}
