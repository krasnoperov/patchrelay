import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import { TERMINAL_STATES } from "./factory-state.ts";

export class TerminalWakeReconciler {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly logger: Logger,
  ) {}

  reconcile(): void {
    for (const issue of this.db.issues.listIssues()) {
      if (!TERMINAL_STATES.has(issue.factoryState) || issue.activeRunId !== undefined) {
        continue;
      }
      if (!this.db.issueSessions.hasPendingIssueSessionEvents(issue.projectId, issue.linearIssueId)
        && issue.pendingRunType === undefined) {
        continue;
      }
      const pendingEvents = this.db.issueSessions.listIssueSessionEvents(issue.projectId, issue.linearIssueId, { pendingOnly: true });
      const clearUpdate = {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        pendingRunType: null,
        pendingRunContextJson: null,
      };
      const commit = this.db.issueSessions.commitIssueState({
        writer: "terminal-wake-reconciler",
        expectedVersion: issue.version,
        update: clearUpdate,
        // Only clear if the issue is still terminal on the fresh row.
        onConflict: (current) => (TERMINAL_STATES.has(current.factoryState) ? clearUpdate : undefined),
      });
      if (commit.outcome !== "applied") continue;
      this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(issue.projectId, issue.linearIssueId);
      // Audit trail: record what was dropped so "why didn't this retry?"
      // is answerable later.
      this.logger.info(
        {
          issueKey: issue.issueKey,
          factoryState: issue.factoryState,
          droppedPendingRunType: issue.pendingRunType,
          droppedEventTypes: pendingEvents.map((event) => event.eventType),
        },
        "Reconciliation: cleared stale terminal wake",
      );
    }
  }
}
