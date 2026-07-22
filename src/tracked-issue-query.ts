import type { IssueRecord, RunRecord, TrackedIssueRecord } from "./db-types.ts";
import { buildTrackedIssueRecord } from "./tracked-issue-projector.ts";
import type { IssueStore } from "./db/issue-store.ts";
import type { IssueSessionStore } from "./db/issue-session-store.ts";
import type { RunStore } from "./db/run-store.ts";
import { resolveEffectiveActiveRun } from "./effective-active-run.ts";
import { deriveIssueExecutionStateFromRecords, isIssueExecutionReadyForExecution } from "./issue-execution-state.ts";
import type { RunType } from "./run-type.ts";

export class TrackedIssueQuery {
  constructor(
    private readonly issues: IssueStore,
    private readonly issueSessions: IssueSessionStore,
    private readonly pendingWorkflowTask: { peekRunnableWorkflowTaskRunType(projectId: string, linearIssueId: string): RunType | undefined },
    private readonly runs: RunStore,
  ) {}

  listIssuesReadyForExecution(): Array<{ projectId: string; linearIssueId: string }> {
    return this.issues.listIssues()
      .filter((issue) => {
        const latestRun = this.runs.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
        const activeRun = issue.activeRunId !== undefined ? this.runs.getRunById(issue.activeRunId) : undefined;
        const runnableTaskRunType = this.pendingWorkflowTask.peekRunnableWorkflowTaskRunType(issue.projectId, issue.linearIssueId);
        return isIssueExecutionReadyForExecution(deriveIssueExecutionStateFromRecords(issue, {
          ...(activeRun ? { activeRun } : {}),
          ...(latestRun ? { latestRun } : {}),
          blockedByKeys: this.issues.listIssueDependencies(issue.projectId, issue.linearIssueId)
            .filter((entry) => entry.blockerCurrentLinearStateType !== "completed"
              && entry.blockerCurrentLinearState?.trim().toLowerCase() !== "done")
            .map((entry) => entry.blockerIssueKey ?? entry.blockerLinearIssueId),
          ...(runnableTaskRunType ? { runnableTaskRunType } : {}),
        }));
      })
      .map((issue) => ({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
      }));
  }

  issueToTrackedIssue(issue: IssueRecord): TrackedIssueRecord {
    const runnableTaskRunType = this.pendingWorkflowTask.peekRunnableWorkflowTaskRunType(issue.projectId, issue.linearIssueId);
    return buildTrackedIssueRecord({
      issue,
      session: this.issueSessions.getIssueSession(issue.projectId, issue.linearIssueId),
      blockedBy: this.issues.listIssueDependencies(issue.projectId, issue.linearIssueId),
      ...(runnableTaskRunType ? { runnableTaskRunType } : {}),
      latestRun: this.runs.getLatestRunForIssue(issue.projectId, issue.linearIssueId),
      latestEvent: this.issueSessions.listIssueSessionEvents(issue.projectId, issue.linearIssueId, { limit: 1 }).at(-1),
    });
  }

  getTrackedIssue(projectId: string, linearIssueId: string): TrackedIssueRecord | undefined {
    const issue = this.issues.getIssue(projectId, linearIssueId);
    return issue ? this.issueToTrackedIssue(issue) : undefined;
  }

  getTrackedIssueByKey(issueKey: string): TrackedIssueRecord | undefined {
    const issue = this.issues.getIssueByKey(issueKey);
    return issue ? this.issueToTrackedIssue(issue) : undefined;
  }

  getIssueOverview(issueKey: string): {
    issue: TrackedIssueRecord;
    activeRun?: RunRecord;
  } | undefined {
    const issue = this.issues.getIssueByKey(issueKey);
    if (!issue) return undefined;
    const tracked = this.issueToTrackedIssue(issue);
    const activeRun = resolveEffectiveActiveRun({
      activeRun: issue.activeRunId ? this.runs.getRunById(issue.activeRunId) : undefined,
      latestRun: this.runs.getLatestRunForIssue(issue.projectId, issue.linearIssueId),
    });
    return {
      issue: tracked,
      ...(activeRun ? { activeRun } : {}),
    };
  }

}
