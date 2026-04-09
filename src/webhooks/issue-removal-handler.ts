import type { PatchRelayDatabase } from "../db.ts";
import { TERMINAL_STATES } from "../factory-state.ts";
import type { OperatorEventFeed } from "../operator-feed.ts";
import type { IssueMetadata, TrackedIssueRecord } from "../types.ts";

export class IssueRemovalHandler {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly feed?: OperatorEventFeed,
  ) {}

  async handle(params: {
    projectId: string;
    issue: IssueMetadata;
    trackedIssue: TrackedIssueRecord | undefined;
    stopActiveRun: (run: NonNullable<ReturnType<PatchRelayDatabase["runs"]["getRunById"]>>, input: string) => Promise<void>;
  }): Promise<void> {
    if (!params.trackedIssue) return;

    const removedIssue = this.db.getIssue(params.projectId, params.issue.id);
    const activeLease = this.db.issueSessions.getActiveIssueSessionLease(params.projectId, params.issue.id);
    const commitRemoval = () => {
      if (removedIssue?.activeRunId) {
        const run = this.db.runs.getRunById(removedIssue.activeRunId);
        if (run) {
          this.db.runs.finishRun(run.id, { status: "released", failureReason: "Issue removed from Linear" });
        }
        return this.db.upsertIssue({
          projectId: params.projectId,
          linearIssueId: params.issue.id,
          activeRunId: null,
          pendingRunType: null,
          factoryState: "failed" as never,
        });
      }
      if (removedIssue && !TERMINAL_STATES.has(removedIssue.factoryState)) {
        return this.db.upsertIssue({
          projectId: params.projectId,
          linearIssueId: params.issue.id,
          pendingRunType: null,
          factoryState: "failed" as never,
        });
      }
      return removedIssue;
    };

    if (removedIssue?.activeRunId) {
      const run = this.db.runs.getRunById(removedIssue.activeRunId);
      if (run) {
        await params.stopActiveRun(run, "STOP: The Linear issue was removed. Stop working immediately and exit.");
      }
    }

    if (activeLease) {
      this.db.issueSessions.withIssueSessionLease(params.projectId, params.issue.id, activeLease.leaseId, commitRemoval);
    } else {
      commitRemoval();
    }

    this.db.issueSessions.appendIssueSessionEvent({
      projectId: params.projectId,
      linearIssueId: params.issue.id,
      eventType: "issue_removed",
      dedupeKey: `issue_removed:${params.issue.id}`,
    });
    this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(params.projectId, params.issue.id);
    this.db.issueSessions.releaseIssueSessionLeaseRespectingActiveLease(params.projectId, params.issue.id);
    this.feed?.publish({
      level: "warn",
      kind: "stage",
      issueKey: params.issue.identifier,
      projectId: params.projectId,
      stage: "failed",
      status: "issue_removed",
      summary: "Issue removed from Linear",
    });
  }
}
