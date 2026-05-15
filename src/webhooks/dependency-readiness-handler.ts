import type { PatchRelayDatabase } from "../db.ts";
import type { RunType } from "../factory-state.ts";
import type { WakeDispatcher } from "../wake-dispatcher.ts";

export class DependencyReadinessHandler {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly wakeDispatcher: WakeDispatcher,
    private readonly peekPendingSessionWakeRunType: (projectId: string, issueId: string) => RunType | undefined,
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
        if (this.peekPendingSessionWakeRunType(projectId, dependent.linearIssueId) === "implementation"
          && issue.activeRunId === undefined
          && !this.db.issueSessions.hasPendingIssueSessionEvents(projectId, dependent.linearIssueId)) {
          this.db.issues.upsertIssue({
            projectId,
            linearIssueId: dependent.linearIssueId,
            pendingRunType: null,
            pendingRunContextJson: null,
          });
        }
        continue;
      }

      if (issue.factoryState !== "delegated"
        || !issue.delegatedToPatchRelay
        || issue.activeRunId !== undefined
        || this.db.issueSessions.hasPendingIssueSessionEvents(projectId, dependent.linearIssueId)) {
        continue;
      }

      if (this.peekPendingSessionWakeRunType(projectId, dependent.linearIssueId) === "implementation") {
        this.db.issues.upsertIssue({
          projectId,
          linearIssueId: dependent.linearIssueId,
          pendingRunType: null,
          pendingRunContextJson: null,
        });
      }
      this.wakeDispatcher.recordEventAndDispatch(projectId, dependent.linearIssueId, {
        eventType: "delegated",
        dedupeKey: `delegated:${dependent.linearIssueId}`,
      });
      newlyReady.push(dependent.linearIssueId);
    }

    return newlyReady;
  }
}
