import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import type { IssueRecord, RunRecord } from "../src/db-types.ts";
import {
  ISSUE_SESSION_HEARTBEAT_INTERVAL_MS,
  ISSUE_SESSION_LEASE_MS,
  IssueSessionLeaseService,
} from "../src/issue-session-lease-service.ts";
import type { PatchRelayTelemetryEvent } from "../src/telemetry.ts";

function setup(prefix: string): {
  baseDir: string;
  db: PatchRelayDatabase;
  telemetryEvents: PatchRelayTelemetryEvent[];
  buildService: (workerId: string) => IssueSessionLeaseService;
  cleanup: () => void;
} {
  const baseDir = mkdtempSync(path.join(tmpdir(), prefix));
  const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
  db.runMigrations();
  const telemetryEvents: PatchRelayTelemetryEvent[] = [];
  const telemetry = { emit: (event: PatchRelayTelemetryEvent) => { telemetryEvents.push(event); } };
  return {
    baseDir,
    db,
    telemetryEvents,
    buildService: (workerId: string) => new IssueSessionLeaseService(db, pino({ enabled: false }), workerId, telemetry),
    cleanup: () => rmSync(baseDir, { recursive: true, force: true }),
  };
}

function seedIssue(db: PatchRelayDatabase, linearIssueId: string, issueKey: string): IssueRecord {
  return db.upsertIssue({
    projectId: "usertold",
    linearIssueId,
    issueKey,
    workflowOutcome: undefined,
  });
}

function seedActiveRun(db: PatchRelayDatabase, issue: IssueRecord): { issue: IssueRecord; run: RunRecord } {
  const run = db.runs.createRun({
    issueId: issue.id,
    projectId: issue.projectId,
    linearIssueId: issue.linearIssueId,
    runType: "implementation",
    promptText: "implement",
  });
  const updated = db.upsertIssue({
    projectId: issue.projectId,
    linearIssueId: issue.linearIssueId,
    activeRunId: run.id,
    workflowOutcome: undefined,
  });
  return { issue: updated, run: db.runs.getRunById(run.id)! };
}

function leaseTelemetryTypes(events: PatchRelayTelemetryEvent[]): string[] {
  return events.map((event) => event.type).filter((type) => type.startsWith("lease."));
}

test("lease validity self-heals after DB-side release (DB row is the only truth)", () => {
  const { db, buildService, cleanup } = setup("patchrelay-lease-service-");
  try {
    seedIssue(db, "issue-stale-local-lease", "USE-LEASE-SERVICE");
    const leases = buildService("worker-test");

    const leaseId = leases.acquire("usertold", "issue-stale-local-lease");
    assert.ok(leaseId);
    assert.equal(leases.hasLocalLease("usertold", "issue-stale-local-lease"), true);

    db.issueSessions.releaseIssueSessionLeaseRespectingActiveLease("usertold", "issue-stale-local-lease");

    assert.equal(db.issueSessions.getIssueSession("usertold", "issue-stale-local-lease")?.leaseId, undefined);
    assert.equal(leases.hasLocalLease("usertold", "issue-stale-local-lease"), false);
    assert.equal(leases.getHeldLease("usertold", "issue-stale-local-lease"), undefined);

    const reacquired = leases.acquire("usertold", "issue-stale-local-lease");
    assert.ok(reacquired);
    assert.notEqual(reacquired, leaseId);
  } finally {
    cleanup();
  }
});

test("restart loses no lease truth: a fresh service over the same DB still honors the lease", () => {
  const { db, buildService, cleanup } = setup("patchrelay-lease-restart-");
  try {
    seedIssue(db, "issue-restart", "USE-RESTART");
    const before = buildService("patchrelay:before-restart");
    const leaseId = before.acquire("usertold", "issue-restart");
    assert.ok(leaseId);

    // Same worker id after "restart" (fresh objects, same DB): the lease is
    // still held — no in-memory state was lost because none exists.
    const sameWorker = buildService("patchrelay:before-restart");
    assert.equal(sameWorker.hasLocalLease("usertold", "issue-restart"), true);
    assert.equal(sameWorker.getHeldLease("usertold", "issue-restart")?.leaseId, leaseId);
    assert.equal(sameWorker.withHeldLease("usertold", "issue-restart", () => "ran"), "ran");
    assert.equal(sameWorker.heartbeat("usertold", "issue-restart"), true);

    // A different worker still sees a live foreign lease: not held locally,
    // acquire denied, reconciliation claim skipped.
    const otherWorker = buildService("patchrelay:after-restart");
    assert.equal(otherWorker.hasLocalLease("usertold", "issue-restart"), false);
    assert.equal(otherWorker.acquire("usertold", "issue-restart"), undefined);
    assert.equal(otherWorker.claimForReconciliation("usertold", "issue-restart"), "skip");
    assert.equal(otherWorker.heartbeat("usertold", "issue-restart"), false);

    // The DB row was never disturbed by the denied calls.
    assert.equal(db.issueSessions.getIssueSession("usertold", "issue-restart")?.leaseId, leaseId);
  } finally {
    cleanup();
  }
});

test("claimForReconciliation returns owned for this worker's live lease and reclaims expired leases", () => {
  const { db, buildService, telemetryEvents, cleanup } = setup("patchrelay-lease-claim-");
  try {
    seedIssue(db, "issue-claim", "USE-CLAIM");
    const service = buildService("patchrelay:claimer");

    assert.ok(service.acquire("usertold", "issue-claim"));
    assert.equal(service.claimForReconciliation("usertold", "issue-claim"), "owned");

    // TTL expiry still works: an expired foreign lease is observable and
    // re-acquirable by anyone.
    db.issueSessions.forceAcquireIssueSessionLease({
      projectId: "usertold",
      linearIssueId: "issue-claim",
      leaseId: "expired-foreign",
      workerId: "patchrelay:dead-process",
      leasedUntil: new Date(Date.now() - 1_000).toISOString(),
    });
    telemetryEvents.length = 0;
    assert.equal(service.claimForReconciliation("usertold", "issue-claim"), true);
    assert.deepEqual(leaseTelemetryTypes(telemetryEvents), ["lease.expired", "lease.acquired"]);
    const session = db.issueSessions.getIssueSession("usertold", "issue-claim");
    assert.equal(session?.workerId, "patchrelay:claimer");
  } finally {
    cleanup();
  }
});

test("reclaimForeignRecoveryLeaseIfSafe reclaims at 2x heartbeat staleness and is denied while the heartbeat is fresh", () => {
  const { db, buildService, telemetryEvents, cleanup } = setup("patchrelay-lease-reclaim-");
  try {
    const { issue, run } = seedActiveRun(db, seedIssue(db, "issue-reclaim", "USE-RECLAIM"));
    const service = buildService("patchrelay:recoverer");

    const foreignLease = (heartbeatAgeMs: number) => {
      assert.equal(db.issueSessions.forceAcquireIssueSessionLease({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        leaseId: `foreign-${heartbeatAgeMs}`,
        workerId: "patchrelay:dead-process",
        leasedUntil: new Date(Date.now() - heartbeatAgeMs + ISSUE_SESSION_LEASE_MS).toISOString(),
      }), true);
    };

    // Fresh heartbeat: the holder is presumed alive — no reclaim.
    foreignLease(0);
    assert.equal(service.reclaimForeignRecoveryLeaseIfSafe(run, issue), false);

    // Just under the 2x heartbeat budget: still denied.
    foreignLease(2 * ISSUE_SESSION_HEARTBEAT_INTERVAL_MS - 5_000);
    assert.equal(service.reclaimForeignRecoveryLeaseIfSafe(run, issue), false);
    assert.equal(db.issueSessions.getIssueSession(issue.projectId, issue.linearIssueId)?.workerId, "patchrelay:dead-process");

    // Past the 2x heartbeat budget (but far from TTL expiry): reclaimed.
    foreignLease(2 * ISSUE_SESSION_HEARTBEAT_INTERVAL_MS + 5_000);
    telemetryEvents.length = 0;
    assert.equal(service.reclaimForeignRecoveryLeaseIfSafe(run, issue), true);
    assert.equal(db.issueSessions.getIssueSession(issue.projectId, issue.linearIssueId)?.workerId, "patchrelay:recoverer");
    assert.deepEqual(leaseTelemetryTypes(telemetryEvents), ["lease.acquired", "lease.reclaimed"]);
  } finally {
    cleanup();
  }
});

test("reclaimForeignRecoveryLeaseIfSafe refuses when the lease is its own or the run slot moved on", () => {
  const { db, buildService, cleanup } = setup("patchrelay-lease-reclaim-guards-");
  try {
    const { issue, run } = seedActiveRun(db, seedIssue(db, "issue-reclaim-guards", "USE-RECLAIM-G"));
    const service = buildService("patchrelay:recoverer");

    // Own lease: nothing to reclaim.
    assert.ok(service.acquire(issue.projectId, issue.linearIssueId));
    assert.equal(service.reclaimForeignRecoveryLeaseIfSafe(run, issue), false);

    // Stale foreign lease, but the issue no longer points at this run.
    assert.equal(db.issueSessions.forceAcquireIssueSessionLease({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      leaseId: "foreign-stale",
      workerId: "patchrelay:dead-process",
      leasedUntil: new Date(Date.now() + ISSUE_SESSION_LEASE_MS - 3 * ISSUE_SESSION_HEARTBEAT_INTERVAL_MS).toISOString(),
    }), true);
    const movedOn = { ...issue, activeRunId: run.id + 1 };
    assert.equal(service.reclaimForeignRecoveryLeaseIfSafe(run, movedOn), false);
  } finally {
    cleanup();
  }
});

test("heartbeat renews only this worker's lease; release leaves an active foreign lease alone", () => {
  const { db, buildService, telemetryEvents, cleanup } = setup("patchrelay-lease-heartbeat-");
  try {
    seedIssue(db, "issue-heartbeat", "USE-HEARTBEAT");
    const owner = buildService("patchrelay:owner");
    const other = buildService("patchrelay:other");

    assert.ok(owner.acquire("usertold", "issue-heartbeat"));
    const before = db.issueSessions.getIssueSession("usertold", "issue-heartbeat")?.leasedUntil;
    assert.equal(other.heartbeat("usertold", "issue-heartbeat"), false);
    assert.equal(db.issueSessions.getIssueSession("usertold", "issue-heartbeat")?.leasedUntil, before);
    assert.equal(owner.heartbeat("usertold", "issue-heartbeat"), true);

    // A non-holder's release must not clear the owner's live lease.
    telemetryEvents.length = 0;
    other.release("usertold", "issue-heartbeat");
    assert.ok(db.issueSessions.getIssueSession("usertold", "issue-heartbeat")?.leaseId);
    assert.deepEqual(leaseTelemetryTypes(telemetryEvents), []);

    // The owner's release clears it and emits lease.released.
    owner.release("usertold", "issue-heartbeat");
    assert.equal(db.issueSessions.getIssueSession("usertold", "issue-heartbeat")?.leaseId, undefined);
    assert.deepEqual(leaseTelemetryTypes(telemetryEvents), ["lease.released"]);
  } finally {
    cleanup();
  }
});
