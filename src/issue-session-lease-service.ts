import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, IssueSessionRecord, RunRecord } from "./db-types.ts";
import { peekPendingWakeRunType } from "./pending-wake.ts";
import { emitTelemetry, noopTelemetry, type PatchRelayTelemetry } from "./telemetry.ts";

export const ISSUE_SESSION_LEASE_MS = 10 * 60_000;

/**
 * Expected heartbeat cadence for a live lease holder. Heartbeats are
 * notification-driven (every Codex notification renews the lease) rather
 * than timer-driven, so this is the staleness budget granted to a live
 * holder, not a timer the service runs. A foreign holder whose inferred
 * last heartbeat (`leasedUntil - ISSUE_SESSION_LEASE_MS`) is older than
 * 2x this budget is presumed dead (crashed process) and its lease may be
 * reclaimed for recovery without waiting for full TTL expiry.
 */
export const ISSUE_SESSION_HEARTBEAT_INTERVAL_MS = 60_000;
const FOREIGN_LEASE_RECLAIM_STALENESS_MS = 2 * ISSUE_SESSION_HEARTBEAT_INTERVAL_MS;

export interface IssueSessionLease {
  projectId: string;
  linearIssueId: string;
  leaseId: string;
}

export type WithHeldIssueSessionLease = <T>(
  projectId: string,
  linearIssueId: string,
  fn: (lease: IssueSessionLease) => T,
) => T | undefined;

export type ReleaseIssueSessionLease = (projectId: string, linearIssueId: string) => void;

export type GetHeldIssueSessionLease = (projectId: string, linearIssueId: string) => IssueSessionLease | undefined;

/**
 * Issue-session lease coordination over the `issue_sessions` lease columns.
 * The DB row (`lease_id`, `worker_id`, `leased_until`) is the only truth —
 * there is no in-memory mirror, so a restarted process loses no lease state
 * (D4, core simplification plan). "Held by us" means the row carries this
 * service's `workerId` with an unexpired `leased_until`.
 */
export class IssueSessionLeaseService {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly logger: Logger,
    readonly workerId: string,
    private readonly telemetry: PatchRelayTelemetry = noopTelemetry,
  ) {}

  hasLocalLease(projectId: string, linearIssueId: string): boolean {
    return this.getHeldLease(projectId, linearIssueId) !== undefined;
  }

  getHeldLease(projectId: string, linearIssueId: string): IssueSessionLease | undefined {
    const session = this.db.issueSessions.getIssueSession(projectId, linearIssueId);
    if (!session?.leaseId || session.workerId !== this.workerId || !isLeaseActive(session)) {
      return undefined;
    }
    return { projectId, linearIssueId, leaseId: session.leaseId };
  }

  withHeldLease<T>(
    projectId: string,
    linearIssueId: string,
    fn: (lease: IssueSessionLease) => T,
  ): T | undefined {
    const lease = this.getHeldLease(projectId, linearIssueId);
    if (!lease) return undefined;
    // Re-validated inside the store's transaction so the check and the
    // guarded writes are atomic.
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
    if (!acquired) {
      this.emitLease("lease.acquire_failed", projectId, linearIssueId);
      this.emitStaleLeaseInvariantIfRunnable(projectId, linearIssueId);
      return undefined;
    }
    this.emitLease("lease.acquired", projectId, linearIssueId, leaseId);
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
    if (!acquired) {
      this.emitLease("lease.acquire_failed", projectId, linearIssueId);
      return undefined;
    }
    this.emitLease("lease.acquired", projectId, linearIssueId, leaseId);
    return leaseId;
  }

  claimForReconciliation(projectId: string, linearIssueId: string): boolean | "owned" | "skip" {
    const session = this.db.issueSessions.getIssueSession(projectId, linearIssueId);
    if (!session) return "skip";
    if (isLeaseActive(session)) {
      if (session.workerId === this.workerId) {
        return "owned";
      }
      this.emitStaleLeaseInvariantIfRunnable(projectId, linearIssueId);
      return "skip";
    }
    if (session.leaseId) {
      this.emitLease("lease.expired", projectId, linearIssueId, session.leaseId);
    }
    return this.acquire(projectId, linearIssueId) ? true : "skip";
  }

  /**
   * Post-crash recovery shortcut: take over a foreign (other-worker) lease on
   * an issue whose active run needs recovery, without waiting for full TTL
   * expiry. Safe purely on heartbeat staleness — post-phase-B invariants make
   * the recovery path idempotent (settleRun is idempotent, slot-clearing has
   * exactly one owner, recovery is detect → RunFailurePolicy → settleRun) —
   * so no Codex thread probing is needed. A holder that has not heartbeat
   * for 2x the heartbeat budget is presumed dead.
   */
  reclaimForeignRecoveryLeaseIfSafe(run: RunRecord, issue: IssueRecord): boolean {
    const session = this.db.issueSessions.getIssueSession(run.projectId, run.linearIssueId);
    if (!session?.leaseId || !session.workerId || session.workerId === this.workerId) {
      return false;
    }
    if (issue.activeRunId !== run.id) {
      return false;
    }
    const leasedUntilMs = session.leasedUntil ? Date.parse(session.leasedUntil) : Number.NaN;
    // A lease row without a parseable leasedUntil cannot prove a live holder.
    const heartbeatAgeMs = Number.isFinite(leasedUntilMs)
      ? Date.now() - (leasedUntilMs - ISSUE_SESSION_LEASE_MS)
      : Number.POSITIVE_INFINITY;
    if (heartbeatAgeMs < FOREIGN_LEASE_RECLAIM_STALENESS_MS) {
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
      heartbeatAgeMs: Math.round(heartbeatAgeMs),
      reclaimedLeaseId: leaseId,
    }, "Reclaimed foreign issue-session lease for active-run recovery");
    emitTelemetry(this.telemetry, {
      type: "lease.reclaimed",
      projectId: run.projectId,
      linearIssueId: run.linearIssueId,
      issueKey: issue.issueKey,
      runId: run.id,
      runType: run.runType,
      leaseId,
      workerId: this.workerId,
    });
    return true;
  }

  heartbeat(projectId: string, linearIssueId: string): boolean {
    const session = this.db.issueSessions.getIssueSession(projectId, linearIssueId);
    // Only this worker's lease may be renewed: extending a foreign holder's
    // lease would let a launch proceed against a lease we do not hold.
    if (!session?.leaseId || session.workerId !== this.workerId) {
      return false;
    }
    return this.db.issueSessions.renewIssueSessionLease({
      projectId,
      linearIssueId,
      leaseId: session.leaseId,
      leasedUntil: new Date(Date.now() + ISSUE_SESSION_LEASE_MS).toISOString(),
    });
  }

  release(projectId: string, linearIssueId: string): void {
    const session = this.db.issueSessions.getIssueSession(projectId, linearIssueId);
    const ownLeaseId = session?.workerId === this.workerId ? session.leaseId : undefined;
    if (!ownLeaseId && session?.leaseId && isLeaseActive(session)) {
      // An active foreign lease is not ours to clear; expired leftovers are
      // swept by releaseExpiredIssueSessionLeases.
      return;
    }
    this.db.issueSessions.releaseIssueSessionLease(projectId, linearIssueId, ownLeaseId);
    this.emitLease("lease.released", projectId, linearIssueId, ownLeaseId);
  }

  private emitLease(
    type: "lease.acquired" | "lease.acquire_failed" | "lease.released" | "lease.expired",
    projectId: string,
    linearIssueId: string,
    leaseId?: string,
  ): void {
    const issue = this.db.issues.getIssue(projectId, linearIssueId);
    emitTelemetry(this.telemetry, {
      type,
      projectId,
      linearIssueId,
      ...(issue?.issueKey ? { issueKey: issue.issueKey } : {}),
      ...(issue?.activeRunId ? { runId: issue.activeRunId } : {}),
      ...(leaseId ? { leaseId } : {}),
      workerId: this.workerId,
    });
  }

  private emitStaleLeaseInvariantIfRunnable(projectId: string, linearIssueId: string): void {
    const issue = this.db.issues.getIssue(projectId, linearIssueId);
    const runType = peekPendingWakeRunType(this.db, projectId, linearIssueId) ?? issue?.pendingRunType;
    if (!runType) return;
    emitTelemetry(this.telemetry, {
      type: "health.invariant",
      invariant: "stale_lease_blocking_runnable_work",
      status: "observed",
      projectId,
      linearIssueId,
      ...(issue?.issueKey ? { issueKey: issue.issueKey } : {}),
      runType,
      detail: "Runnable work could not acquire an issue-session lease",
    });
  }
}

function isLeaseActive(
  session: Pick<IssueSessionRecord, "leaseId" | "leasedUntil">,
  now = Date.now(),
): boolean {
  if (!session.leaseId || !session.leasedUntil) return false;
  const leasedUntilMs = Date.parse(session.leasedUntil);
  return Number.isFinite(leasedUntilMs) && leasedUntilMs > now;
}
