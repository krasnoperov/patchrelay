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
      this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(issue.projectId, issue.linearIssueId);
      this.db.issues.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        pendingRunType: null,
        pendingRunContextJson: null,
      });
      this.logger.info(
        { issueKey: issue.issueKey, factoryState: issue.factoryState },
        "Reconciliation: cleared stale terminal wake",
      );
    }
  }
}
