import type { PatchRelayDatabase } from "../db.ts";
import type { RunType } from "../factory-state.ts";
import { emitTelemetry, noopTelemetry, type PatchRelayTelemetry } from "../telemetry.ts";
import type { WakeDispatcher } from "../wake-dispatcher.ts";

const WRITER = "dependency-readiness-handler";

export class DependencyReadinessHandler {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly wakeDispatcher: WakeDispatcher,
    private readonly peekPendingSessionWakeRunType: (projectId: string, issueId: string) => RunType | undefined,
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
        if (this.peekPendingSessionWakeRunType(projectId, dependent.linearIssueId) === "implementation"
          && issue.activeRunId === undefined
          && !this.db.issueSessions.hasPendingIssueSessionEvents(projectId, dependent.linearIssueId)) {
          this.db.issueSessions.commitIssueState({
            writer: WRITER,
            update: {
              projectId,
              linearIssueId: dependent.linearIssueId,
              pendingRunType: null,
              pendingRunContextJson: null,
            },
          });
        }
        continue;
      }

      if (!issue.delegatedToPatchRelay || issue.activeRunId !== undefined) {
        continue;
      }

      const pendingWakeRunType = this.db.workflowWakes.peekIssueWake(projectId, dependent.linearIssueId)?.runType
        ?? issue.pendingRunType;
      if (pendingWakeRunType) {
        const dispatchedRunType = this.wakeDispatcher.dispatchIfWakePending(projectId, dependent.linearIssueId);
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

      if (issue.factoryState !== "delegated" || this.db.issueSessions.hasPendingIssueSessionEvents(projectId, dependent.linearIssueId)) {
        continue;
      }

      if (this.peekPendingSessionWakeRunType(projectId, dependent.linearIssueId) === "implementation") {
        this.db.issueSessions.commitIssueState({
          writer: WRITER,
          update: {
            projectId,
            linearIssueId: dependent.linearIssueId,
            pendingRunType: null,
            pendingRunContextJson: null,
          },
        });
      }
      const dispatchedRunType = this.wakeDispatcher.recordEventAndDispatch(projectId, dependent.linearIssueId, {
        eventType: "delegated",
        dedupeKey: `delegated:${dependent.linearIssueId}`,
      });
      emitTelemetry(this.telemetry, {
        type: "dependency.dependent_unblocked",
        projectId,
        linearIssueId: dependent.linearIssueId,
        ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
        blockerLinearIssueId,
        ...(dispatchedRunType ? { dispatchedRunType } : {}),
      });
      newlyReady.push(dependent.linearIssueId);
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
