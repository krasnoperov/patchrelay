import type { Logger } from "pino";
import type { BranchOwner, IssueRecord, RunRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import type {
  GetHeldIssueSessionLease,
  ReleaseIssueSessionLease,
  WithHeldIssueSessionLease,
} from "./issue-session-lease-service.ts";
import type { LinearSessionSync } from "./linear-session-sync.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { AppendWakeEventWithLease } from "./run-wake-planner.ts";
import { buildRunFailureActivity } from "./linear-session-reporting.ts";

const DEFAULT_ZOMBIE_RECOVERY_BUDGET = 5;
const ZOMBIE_RECOVERY_BASE_DELAY_MS = 15_000;

export class RunRecoveryService {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly logger: Logger,
    private readonly linearSync: LinearSessionSync,
    private readonly withHeldLease: WithHeldIssueSessionLease,
    private readonly getHeldLease: GetHeldIssueSessionLease,
    private readonly appendWakeEventWithLease: AppendWakeEventWithLease,
    private readonly releaseLease: ReleaseIssueSessionLease,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    private readonly resolveBranchOwnerForStateTransition: (newState: FactoryState, pendingRunType?: RunType) => BranchOwner | undefined,
    private readonly feed?: OperatorEventFeed,
  ) {}

  recoverOrEscalate(params: {
    issue: IssueRecord;
    runType: RunType;
    reason: string;
    isRequestedChangesRunType: (runType: RunType) => boolean;
  }): void {
    const { issue, runType, reason } = params;
    const fresh = this.db.issues.getIssue(issue.projectId, issue.linearIssueId);
    if (!fresh) return;

    if (params.isRequestedChangesRunType(runType)) {
      const updated = this.withHeldLease(fresh.projectId, fresh.linearIssueId, (lease) => {
        this.db.issueSessions.clearPendingIssueSessionEventsWithLease(lease);
        this.db.issueSessions.upsertIssueWithLease(lease, {
          projectId: fresh.projectId,
          linearIssueId: fresh.linearIssueId,
          pendingRunType: null,
          pendingRunContextJson: null,
          factoryState: "escalated",
        });
        return true;
      });
      if (!updated) {
        this.logger.warn({ issueKey: fresh.issueKey, reason }, "Skipping review-fix recovery escalation after losing issue-session lease");
        this.releaseLease(fresh.projectId, fresh.linearIssueId);
        return;
      }
      this.logger.warn({ issueKey: fresh.issueKey, reason }, "Requested-changes run failed before a new head was published - escalating");
      this.feed?.publish({
        level: "error",
        kind: "workflow",
        issueKey: fresh.issueKey,
        projectId: fresh.projectId,
        stage: runType,
        status: "escalated",
        summary: `Requested-changes run failed before publishing a new head (${reason})`,
      });
      this.releaseLease(fresh.projectId, fresh.linearIssueId);
      return;
    }

    if (fresh.prState === "merged") {
      const updated = this.withHeldLease(fresh.projectId, fresh.linearIssueId, (lease) => {
        this.db.issueSessions.upsertIssueWithLease(lease, {
          projectId: fresh.projectId,
          linearIssueId: fresh.linearIssueId,
          factoryState: "done",
          zombieRecoveryAttempts: 0,
          lastZombieRecoveryAt: null,
        });
        return true;
      });
      if (!updated) {
        this.logger.warn({ issueKey: fresh.issueKey, reason }, "Skipping merged recovery completion after losing issue-session lease");
        this.releaseLease(fresh.projectId, fresh.linearIssueId);
        return;
      }
      this.logger.info({ issueKey: fresh.issueKey, reason }, "Recovery: PR already merged - transitioning to done");
      this.releaseLease(fresh.projectId, fresh.linearIssueId);
      return;
    }

    const attempts = fresh.zombieRecoveryAttempts + 1;
    if (attempts > DEFAULT_ZOMBIE_RECOVERY_BUDGET) {
      const updated = this.withHeldLease(fresh.projectId, fresh.linearIssueId, (lease) => {
        this.db.issueSessions.upsertIssueWithLease(lease, {
          projectId: fresh.projectId,
          linearIssueId: fresh.linearIssueId,
          factoryState: "escalated",
        });
        return true;
      });
      if (!updated) {
        this.logger.warn({ issueKey: fresh.issueKey, attempts, reason }, "Skipping recovery escalation after losing issue-session lease");
        this.releaseLease(fresh.projectId, fresh.linearIssueId);
        return;
      }
      this.logger.warn({ issueKey: fresh.issueKey, attempts, reason }, "Recovery: budget exhausted - escalating");
      this.feed?.publish({
        level: "error",
        kind: "workflow",
        issueKey: fresh.issueKey,
        projectId: fresh.projectId,
        stage: "escalated",
        status: "budget_exhausted",
        summary: `${reason} recovery failed after ${DEFAULT_ZOMBIE_RECOVERY_BUDGET} attempts`,
      });
      this.releaseLease(fresh.projectId, fresh.linearIssueId);
      return;
    }

    if (fresh.lastZombieRecoveryAt) {
      const elapsed = Date.now() - new Date(fresh.lastZombieRecoveryAt).getTime();
      const delay = ZOMBIE_RECOVERY_BASE_DELAY_MS * Math.pow(2, fresh.zombieRecoveryAttempts);
      if (elapsed < delay) {
        this.logger.debug({ issueKey: fresh.issueKey, attempts: fresh.zombieRecoveryAttempts, delay, elapsed }, "Recovery: backoff not elapsed, skipping");
        return;
      }
    }

    const requeued = this.withHeldLease(fresh.projectId, fresh.linearIssueId, (lease) => {
      this.db.issueSessions.upsertIssueWithLease(lease, {
        projectId: fresh.projectId,
        linearIssueId: fresh.linearIssueId,
        pendingRunType: null,
        pendingRunContextJson: null,
        zombieRecoveryAttempts: attempts,
        lastZombieRecoveryAt: new Date().toISOString(),
      });
      return this.appendWakeEventWithLease(lease, fresh, runType, undefined, `recovery:${attempts}`);
    });
    if (!requeued) {
      this.logger.warn({ issueKey: fresh.issueKey, attempts, reason }, "Skipping recovery re-enqueue after losing issue-session lease");
      this.releaseLease(fresh.projectId, fresh.linearIssueId);
      return;
    }
    this.enqueueIssue(fresh.projectId, fresh.linearIssueId);
    this.logger.info({ issueKey: fresh.issueKey, attempts, reason }, "Recovery: re-enqueued with backoff");
  }

  escalate(params: {
    issue: IssueRecord;
    runType: string;
    reason: string;
  }): void {
    const { issue, runType, reason } = params;
    this.logger.warn({ issueKey: issue.issueKey, runType, reason }, "Escalating to human");
    const escalated = this.withHeldLease(issue.projectId, issue.linearIssueId, (lease) => {
      if (issue.activeRunId) {
        this.db.issueSessions.finishRunWithLease(lease, issue.activeRunId, { status: "released" });
      }
      this.db.issueSessions.clearPendingIssueSessionEventsWithLease(lease);
      this.db.issueSessions.upsertIssueWithLease(lease, {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        pendingRunType: null,
        pendingRunContextJson: null,
        activeRunId: null,
        factoryState: "escalated",
      });
      return true;
    });
    if (!escalated) {
      this.logger.warn({ issueKey: issue.issueKey, runType }, "Skipping escalation write after losing issue-session lease");
      this.releaseLease(issue.projectId, issue.linearIssueId);
      return;
    }
    this.feed?.publish({
      level: "error",
      kind: "workflow",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: runType,
      status: "escalated",
      summary: `Escalated: ${reason}`,
    });
    const escalatedIssue = this.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? issue;
    void this.linearSync.emitActivity(escalatedIssue, {
      type: "error",
      body: `PatchRelay needs human help to continue.\n\n${reason}`,
    });
    void this.linearSync.syncSession(escalatedIssue);
    this.releaseLease(issue.projectId, issue.linearIssueId);
  }

  failRunAndClear(params: {
    run: RunRecord;
    message: string;
    nextState: FactoryState;
  }): void {
    const { run, message, nextState } = params;
    const updated = this.withHeldLease(run.projectId, run.linearIssueId, (lease) => {
      this.db.runs.finishRun(run.id, { status: "failed", failureReason: message });
      if (nextState === "failed" || nextState === "escalated" || nextState === "awaiting_input" || nextState === "done") {
        this.db.issueSessions.clearPendingIssueSessionEventsWithLease(lease);
      }
      this.db.issues.upsertIssue({
        projectId: run.projectId,
        linearIssueId: run.linearIssueId,
        activeRunId: null,
        factoryState: nextState,
      });
      const branchOwner = this.resolveBranchOwnerForStateTransition(nextState);
      if (branchOwner) {
        const heldLease = this.getHeldLease(run.projectId, run.linearIssueId);
        if (heldLease) {
          this.db.issueSessions.setBranchOwnerWithLease(heldLease, branchOwner);
        }
      }
      return true;
    });
    if (!updated) {
      this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Skipping failure cleanup after losing issue-session lease");
    }
    this.releaseLease(run.projectId, run.linearIssueId);
  }

  emitInterruptedFailure(runType: RunType, issue: IssueRecord, message: string): void {
    const latest = this.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? issue;
    void this.linearSync.emitActivity(latest, buildRunFailureActivity(runType, message));
    void this.linearSync.syncSession(latest, { activeRunType: runType });
  }
}
