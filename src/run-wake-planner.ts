import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import type { RunType } from "./factory-state.ts";
import type { IssueSessionLease } from "./issue-session-lease-service.ts";
import type { IssueSessionEventType } from "./issue-session-events.ts";
import {
  getCiRepairBudget,
  getQueueRepairBudget,
  getReviewFixBudget,
} from "./run-budgets.ts";
import { buildRequestedChangesWakeIdentity } from "./reactive-wake-keys.ts";
import type { ProjectConfig } from "./workflow-types.ts";

const WRITER = "run-wake-planner";

export interface PendingRunWake {
  runType: RunType;
  context?: Record<string, unknown> | undefined;
  wakeReason?: string | undefined;
  resumeThread: boolean;
  eventIds: number[];
}

export type AppendWakeEventWithLease = (
  lease: IssueSessionLease,
  issue: Pick<IssueRecord, "projectId" | "linearIssueId" | "prHeadSha" | "lastGitHubFailureSignature" | "lastGitHubFailureHeadSha">,
  runType: RunType,
  context?: Record<string, unknown>,
  dedupeScope?: string,
) => boolean;

export class RunWakePlanner {
  constructor(private readonly db: PatchRelayDatabase) {}

  resolveRunWake(issue: IssueRecord): PendingRunWake | undefined {
    const sessionWake = this.db.workflowWakes.peekIssueWake(issue.projectId, issue.linearIssueId);
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
    lease: IssueSessionLease,
    issue: Pick<IssueRecord, "projectId" | "linearIssueId" | "prHeadSha" | "lastGitHubFailureSignature" | "lastGitHubFailureHeadSha">,
    runType: RunType,
    context?: Record<string, unknown>,
    dedupeScope?: string,
  ): boolean {
    let eventType: IssueSessionEventType;
    let dedupeKey: string;
    let eventContext = context;
    if (runType === "queue_repair") {
      eventType = "merge_steward_incident";
      dedupeKey = `${dedupeScope ?? "wake"}:queue_repair:${issue.linearIssueId}:${issue.prHeadSha ?? issue.lastGitHubFailureHeadSha ?? "unknown-sha"}`;
    } else if (runType === "ci_repair") {
      eventType = "settled_red_ci";
      dedupeKey = `${dedupeScope ?? "wake"}:ci_repair:${issue.linearIssueId}:${issue.lastGitHubFailureSignature ?? issue.prHeadSha ?? "unknown-sha"}`;
    } else if (runType === "review_fix" || runType === "branch_upkeep") {
      eventType = "review_changes_requested";
      const identity = buildRequestedChangesWakeIdentity({
        linearIssueId: issue.linearIssueId,
        runType,
        headSha: issue.prHeadSha,
      });
      dedupeKey = identity.dedupeKey;
      eventContext = {
        ...context,
        requestedChangesCoalesceKey: identity.coalesceKey,
        ...(identity.headSha ? { requestedChangesHeadSha: identity.headSha } : {}),
      };
    } else {
      eventType = "delegated";
      dedupeKey = `${dedupeScope ?? "wake"}:implementation:${issue.linearIssueId}`;
    }

    return Boolean(this.db.issueSessions.appendIssueSessionEventWithLease(lease, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType,
      ...(eventContext ? { eventJson: JSON.stringify(eventContext) } : {}),
      dedupeKey,
    }));
  }

  materializeLegacyPendingWake(
    issue: IssueRecord,
    lease: IssueSessionLease,
  ): IssueRecord {
    if (!issue.pendingRunType) return issue;
    const context = issue.pendingRunContextJson
      ? JSON.parse(issue.pendingRunContextJson) as Record<string, unknown>
      : undefined;
    this.appendWakeEventWithLease(lease, issue, issue.pendingRunType, context, "legacy_pending");
    const commit = this.db.issueSessions.commitIssueState({
      writer: WRITER,
      lease,
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        pendingRunType: null,
        pendingRunContextJson: null,
      },
    });
    if (commit.outcome !== "applied") return issue;
    return commit.issue;
  }

  budgetExceeded(
    issue: IssueRecord,
    project: ProjectConfig | undefined,
    runType: RunType,
    isRequestedChangesRunType: (runType: RunType) => boolean,
  ): string | undefined {
    const ciRepairBudget = getCiRepairBudget(project);
    if (runType === "ci_repair" && issue.ciRepairAttempts >= ciRepairBudget) {
      return `CI repair budget exhausted (${ciRepairBudget} attempts)`;
    }
    const queueRepairBudget = getQueueRepairBudget(project);
    if (runType === "queue_repair" && issue.queueRepairAttempts >= queueRepairBudget) {
      return `Queue repair budget exhausted (${queueRepairBudget} attempts)`;
    }
    const reviewFixBudget = getReviewFixBudget(project);
    if (isRequestedChangesRunType(runType) && issue.reviewFixAttempts >= reviewFixBudget) {
      return `Requested-changes budget exhausted (${reviewFixBudget} attempts)`;
    }
    return undefined;
  }

  incrementAttemptCounters(
    issue: IssueRecord,
    lease: IssueSessionLease,
    runType: RunType,
    isRequestedChangesRunType: (runType: RunType) => boolean,
  ): boolean {
    // The increments are read-modify-write against the issue row (which may
    // be stale by the time the launch path gets here); on conflict, recompute
    // from the fresh row instead of writing a counter derived from the stale
    // read.
    const buildIncrement = (record: Pick<IssueRecord, "ciRepairAttempts" | "queueRepairAttempts" | "reviewFixAttempts">) => {
      if (runType === "ci_repair") {
        return { projectId: issue.projectId, linearIssueId: issue.linearIssueId, ciRepairAttempts: record.ciRepairAttempts + 1 };
      }
      if (runType === "queue_repair") {
        return { projectId: issue.projectId, linearIssueId: issue.linearIssueId, queueRepairAttempts: record.queueRepairAttempts + 1 };
      }
      if (isRequestedChangesRunType(runType)) {
        return { projectId: issue.projectId, linearIssueId: issue.linearIssueId, reviewFixAttempts: record.reviewFixAttempts + 1 };
      }
      return undefined;
    };
    const update = buildIncrement(issue);
    if (!update) return true;
    const commit = this.db.issueSessions.commitIssueState({
      writer: WRITER,
      lease,
      expectedVersion: issue.version,
      update,
      onConflict: (current) => buildIncrement(current),
    });
    return commit.outcome === "applied";
  }
}
