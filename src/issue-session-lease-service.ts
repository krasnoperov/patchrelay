import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { CodexThreadSummary } from "./types.ts";
import { getThreadTurns } from "./codex-thread-utils.ts";

const ISSUE_SESSION_LEASE_MS = 10 * 60_000;

export interface IssueSessionLease {
  projectId: string;
  linearIssueId: string;
  leaseId: string;
}

export class IssueSessionLeaseService {
  readonly activeSessionLeases = new Map<string, string>();

  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly logger: Logger,
    private readonly workerId: string,
    private readonly readThreadWithRetry: (threadId: string, maxRetries?: number) => Promise<CodexThreadSummary>,
  ) {}

  hasLocalLease(projectId: string, linearIssueId: string): boolean {
    return this.activeSessionLeases.has(this.issueSessionLeaseKey(projectId, linearIssueId));
  }

  getHeldLease(projectId: string, linearIssueId: string): IssueSessionLease | undefined {
    const leaseId = this.activeSessionLeases.get(this.issueSessionLeaseKey(projectId, linearIssueId));
    if (!leaseId) return undefined;
    return { projectId, linearIssueId, leaseId };
  }

  withHeldLease<T>(
    projectId: string,
    linearIssueId: string,
    fn: (lease: IssueSessionLease) => T,
  ): T | undefined {
    const lease = this.getHeldLease(projectId, linearIssueId);
    if (!lease) return undefined;
    return this.db.issueSessions.withIssueSessionLease(projectId, linearIssueId, lease.leaseId, () => fn(lease));
  }

  acquire(projectId: string, linearIssueId: string): string | undefined {
    const leaseId = randomUUID();
    const leasedUntil = new Date(Date.now() + ISSUE_SESSION_LEASE_MS).toISOString();
    const acquired = this.db.issueSessions.acquireIssueSessionLease({
      projectId,
      linearIssueId,
      leaseId,
      workerId: this.workerId,
      leasedUntil,
    });
    if (!acquired) return undefined;
    this.activeSessionLeases.set(this.issueSessionLeaseKey(projectId, linearIssueId), leaseId);
    return leaseId;
  }

  forceAcquire(projectId: string, linearIssueId: string): string | undefined {
    const leaseId = randomUUID();
    const leasedUntil = new Date(Date.now() + ISSUE_SESSION_LEASE_MS).toISOString();
    const acquired = this.db.issueSessions.forceAcquireIssueSessionLease({
      projectId,
      linearIssueId,
      leaseId,
      workerId: this.workerId,
      leasedUntil,
    });
    if (!acquired) return undefined;
    this.activeSessionLeases.set(this.issueSessionLeaseKey(projectId, linearIssueId), leaseId);
    return leaseId;
  }

  claimForReconciliation(projectId: string, linearIssueId: string): boolean | "owned" | "skip" {
    const key = this.issueSessionLeaseKey(projectId, linearIssueId);
    if (this.activeSessionLeases.has(key)) {
      return "owned";
    }
    const session = this.db.issueSessions.getIssueSession(projectId, linearIssueId);
    if (!session) return "skip";
    const leasedUntilMs = session.leasedUntil ? Date.parse(session.leasedUntil) : undefined;
    if (leasedUntilMs !== undefined && Number.isFinite(leasedUntilMs) && leasedUntilMs > Date.now()) {
      return "skip";
    }
    return this.acquire(projectId, linearIssueId) ? true : "skip";
  }

  async reclaimForeignRecoveryLeaseIfSafe(run: RunRecord, issue: IssueRecord): Promise<boolean> {
    const key = this.issueSessionLeaseKey(run.projectId, run.linearIssueId);
    if (this.activeSessionLeases.has(key)) {
      return false;
    }
    const session = this.db.issueSessions.getIssueSession(run.projectId, run.linearIssueId);
    if (!session?.leaseId || !session.workerId || session.workerId === this.workerId) {
      return false;
    }
    if (issue.activeRunId !== run.id) {
      return false;
    }

    let safeToReclaim = !run.threadId;
    if (!safeToReclaim && run.threadId) {
      try {
        const thread = await this.readThreadWithRetry(run.threadId, 1);
        const latestTurn = getThreadTurns(thread).at(-1);
        safeToReclaim = thread.status === "notLoaded"
          || latestTurn?.status === "interrupted"
          || latestTurn?.status === "completed";
      } catch {
        safeToReclaim = true;
      }
    }

    if (!safeToReclaim) {
      return false;
    }

    const leaseId = this.forceAcquire(run.projectId, run.linearIssueId);
    if (!leaseId) {
      return false;
    }
    this.logger.info({
      issueKey: issue.issueKey,
      runId: run.id,
      previousWorkerId: session.workerId,
      previousLeaseId: session.leaseId,
      reclaimedLeaseId: leaseId,
    }, "Reclaimed foreign issue-session lease for active-run recovery");
    return true;
  }

  heartbeat(projectId: string, linearIssueId: string): boolean {
    const key = this.issueSessionLeaseKey(projectId, linearIssueId);
    const leaseId = this.activeSessionLeases.get(key) ?? this.db.issueSessions.getIssueSession(projectId, linearIssueId)?.leaseId;
    if (!leaseId) return false;
    const renewed = this.db.issueSessions.renewIssueSessionLease({
      projectId,
      linearIssueId,
      leaseId,
      leasedUntil: new Date(Date.now() + ISSUE_SESSION_LEASE_MS).toISOString(),
    });
    if (renewed) {
      this.activeSessionLeases.set(key, leaseId);
      return true;
    }
    this.activeSessionLeases.delete(key);
    return false;
  }

  release(projectId: string, linearIssueId: string): void {
    const key = this.issueSessionLeaseKey(projectId, linearIssueId);
    const leaseId = this.activeSessionLeases.get(key);
    this.db.issueSessions.releaseIssueSessionLease(projectId, linearIssueId, leaseId);
    this.activeSessionLeases.delete(key);
  }

  private issueSessionLeaseKey(projectId: string, linearIssueId: string): string {
    return `${projectId}:${linearIssueId}`;
  }
}
