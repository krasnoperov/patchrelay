import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import { isIssueTerminalProjection } from "./issue-execution-state.ts";
import { NON_ACTIONABLE_SESSION_EVENTS } from "./issue-session-events.ts";

export class TerminalInboxReconciler {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly logger: Logger,
  ) {}

  reconcile(): void {
    for (const issue of this.db.issues.listTerminalIssuesWithStaleInbox([...NON_ACTIONABLE_SESSION_EVENTS])) {
      if (!isIssueTerminalProjection(issue) || issue.activeRunId !== undefined) {
        continue;
      }
      if (!this.db.issueSessions.hasPendingIssueSessionEvents(issue.projectId, issue.linearIssueId)) {
        continue;
      }
      const pendingEvents = this.db.issueSessions.listIssueSessionEvents(issue.projectId, issue.linearIssueId, { pendingOnly: true });
      const clearUpdate = {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
      };
      const commit = this.db.issueSessions.commitIssueState({
        writer: "terminal-inbox-reconciler",
        expectedVersion: issue.version,
        update: clearUpdate,
        // Only clear if the issue is still terminal on the fresh row.
        onConflict: (current) => (isIssueTerminalProjection(current) ? clearUpdate : undefined),
      });
      if (commit.outcome !== "applied") continue;
      this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(issue.projectId, issue.linearIssueId);
      // Audit trail: record what was dropped so "why didn't this retry?"
      // is answerable later.
      this.logger.info(
        {
          issueKey: issue.issueKey,
          workflowOutcome: issue.workflowOutcome,
          droppedEventTypes: pendingEvents.map((event) => event.eventType),
        },
        "Reconciliation: cleared stale terminal inbox",
      );
    }
  }
}
