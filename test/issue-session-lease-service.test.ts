import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { IssueSessionLeaseService } from "../src/issue-session-lease-service.ts";

test("local issue-session lease cache self-heals after DB-side release", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-lease-service-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-stale-local-lease",
      issueKey: "USE-LEASE-SERVICE",
      factoryState: "delegated",
    });

    const leases = new IssueSessionLeaseService(
      db,
      pino({ enabled: false }),
      "worker-test",
      async () => ({ id: "thread", status: "completed", turns: [] } as never),
    );

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
    rmSync(baseDir, { recursive: true, force: true });
  }
});
