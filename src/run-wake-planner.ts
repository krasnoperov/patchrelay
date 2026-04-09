import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import type { RunType } from "./factory-state.ts";
import type { IssueSessionEventType } from "./issue-session-events.ts";

const DEFAULT_CI_REPAIR_BUDGET = 3;
const DEFAULT_QUEUE_REPAIR_BUDGET = 3;
const DEFAULT_REVIEW_FIX_BUDGET = 12;

export interface PendingRunWake {
  runType: RunType;
  context?: Record<string, unknown> | undefined;
  wakeReason?: string | undefined;
  resumeThread: boolean;
  eventIds: number[];
}

export class RunWakePlanner {
  constructor(private readonly db: PatchRelayDatabase) {}

  resolveRunWake(issue: IssueRecord): PendingRunWake | undefined {
    const sessionWake = this.db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId);
    if (!sessionWake) return undefined;
    return {
      runType: sessionWake.runType,
      context: sessionWake.context,
      wakeReason: sessionWake.wakeReason,
      resumeThread: sessionWake.resumeThread,
      eventIds: sessionWake.eventIds,
    };
  }

  appendWakeEventWithLease(
    lease: { projectId: string; linearIssueId: string; leaseId: string },
    issue: Pick<IssueRecord, "projectId" | "linearIssueId" | "prHeadSha" | "lastGitHubFailureSignature" | "lastGitHubFailureHeadSha">,
    runType: RunType,
    context?: Record<string, unknown>,
    dedupeScope?: string,
  ): boolean {
    let eventType: IssueSessionEventType;
    let dedupeKey: string;
    if (runType === "queue_repair") {
      eventType = "merge_steward_incident";
      dedupeKey = `${dedupeScope ?? "wake"}:queue_repair:${issue.linearIssueId}:${issue.prHeadSha ?? issue.lastGitHubFailureHeadSha ?? "unknown-sha"}`;
    } else if (runType === "ci_repair") {
      eventType = "settled_red_ci";
      dedupeKey = `${dedupeScope ?? "wake"}:ci_repair:${issue.linearIssueId}:${issue.lastGitHubFailureSignature ?? issue.prHeadSha ?? "unknown-sha"}`;
    } else if (runType === "review_fix" || runType === "branch_upkeep") {
      eventType = "review_changes_requested";
      dedupeKey = `${dedupeScope ?? "wake"}:${runType}:${issue.linearIssueId}:${issue.prHeadSha ?? "unknown-sha"}`;
    } else {
      eventType = "delegated";
      dedupeKey = `${dedupeScope ?? "wake"}:implementation:${issue.linearIssueId}`;
    }

    return Boolean(this.db.issueSessions.appendIssueSessionEventWithLease(lease, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType,
      ...(context ? { eventJson: JSON.stringify(context) } : {}),
      dedupeKey,
    }));
  }

  materializeLegacyPendingWake(
    issue: IssueRecord,
    lease: { projectId: string; linearIssueId: string; leaseId: string },
  ): IssueRecord {
    if (!issue.pendingRunType) return issue;
    const context = issue.pendingRunContextJson
      ? JSON.parse(issue.pendingRunContextJson) as Record<string, unknown>
      : undefined;
    this.appendWakeEventWithLease(lease, issue, issue.pendingRunType, context, "legacy_pending");
    const updated = this.db.issueSessions.upsertIssueWithLease(lease, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      pendingRunType: null,
      pendingRunContextJson: null,
    });
    if (!updated) return issue;
    return this.db.getIssue(issue.projectId, issue.linearIssueId) ?? issue;
  }

  budgetExceeded(issue: IssueRecord, runType: RunType, isRequestedChangesRunType: (runType: RunType) => boolean): string | undefined {
    if (runType === "ci_repair" && issue.ciRepairAttempts >= DEFAULT_CI_REPAIR_BUDGET) {
      return `CI repair budget exhausted (${DEFAULT_CI_REPAIR_BUDGET} attempts)`;
    }
    if (runType === "queue_repair" && issue.queueRepairAttempts >= DEFAULT_QUEUE_REPAIR_BUDGET) {
      return `Queue repair budget exhausted (${DEFAULT_QUEUE_REPAIR_BUDGET} attempts)`;
    }
    if (isRequestedChangesRunType(runType) && issue.reviewFixAttempts >= DEFAULT_REVIEW_FIX_BUDGET) {
      return `Requested-changes budget exhausted (${DEFAULT_REVIEW_FIX_BUDGET} attempts)`;
    }
    return undefined;
  }

  incrementAttemptCounters(
    issue: IssueRecord,
    lease: { projectId: string; linearIssueId: string; leaseId: string },
    runType: RunType,
    isRequestedChangesRunType: (runType: RunType) => boolean,
  ): boolean {
    if (runType === "ci_repair") {
      return Boolean(this.db.issueSessions.upsertIssueWithLease(lease, {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        ciRepairAttempts: issue.ciRepairAttempts + 1,
      }));
    }
    if (runType === "queue_repair") {
      return Boolean(this.db.issueSessions.upsertIssueWithLease(lease, {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        queueRepairAttempts: issue.queueRepairAttempts + 1,
      }));
    }
    if (isRequestedChangesRunType(runType)) {
      return Boolean(this.db.issueSessions.upsertIssueWithLease(lease, {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        reviewFixAttempts: issue.reviewFixAttempts + 1,
      }));
    }
    return true;
  }
}
