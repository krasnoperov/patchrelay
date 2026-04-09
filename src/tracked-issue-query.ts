import type { IssueRecord, RunRecord, TrackedIssueRecord } from "./db-types.ts";
import type { FactoryState } from "./factory-state.ts";
import { buildTrackedIssueRecord } from "./tracked-issue-projector.ts";
import { deriveIssueSessionState, isIssueSessionReadyForExecution } from "./issue-session.ts";
import type { IssueStore } from "./db/issue-store.ts";
import type { IssueSessionStore } from "./db/issue-session-store.ts";
import type { RunStore } from "./db/run-store.ts";

export class TrackedIssueQuery {
  constructor(
    private readonly issues: IssueStore,
    private readonly issueSessions: IssueSessionStore,
    private readonly runs: RunStore,
  ) {}

  listIssuesReadyForExecution(): Array<{ projectId: string; linearIssueId: string }> {
    return this.issues.listIssues()
      .filter((issue) => isIssueSessionReadyForExecution({
        factoryState: issue.factoryState,
        sessionState: deriveIssueSessionState({
          activeRunId: issue.activeRunId,
          factoryState: issue.factoryState,
        }),
        activeRunId: issue.activeRunId,
        blockedByCount: this.issues.countUnresolvedBlockers(issue.projectId, issue.linearIssueId),
        hasPendingWake: this.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId) !== undefined,
        hasLegacyPendingRun: issue.pendingRunType !== undefined,
        prNumber: issue.prNumber,
        prState: issue.prState,
        prReviewState: issue.prReviewState,
        prCheckStatus: issue.prCheckStatus,
        latestFailureSource: issue.lastGitHubFailureSource,
      }))
      .map((issue) => ({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
      }));
  }

  issueToTrackedIssue(issue: IssueRecord): TrackedIssueRecord {
    return buildTrackedIssueRecord({
      issue,
      session: this.issueSessions.getIssueSession(issue.projectId, issue.linearIssueId),
      blockedBy: this.issues.listIssueDependencies(issue.projectId, issue.linearIssueId),
      hasPendingWake: this.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId) !== undefined,
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
    const activeRun = issue.activeRunId ? this.runs.getRunById(issue.activeRunId) : undefined;
    return {
      issue: tracked,
      ...(activeRun ? { activeRun } : {}),
    };
  }

  listIssuesByState(projectId: string, state: FactoryState): IssueRecord[] {
    return this.issues.listIssuesByState(projectId, state);
  }
}
