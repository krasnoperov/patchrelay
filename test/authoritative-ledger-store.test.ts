import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import type {
  AuthoritativeLedgerStoreProvider,
  EventReceiptStoreProvider,
  IssueControlStoreProvider,
  ObligationStoreProvider,
  RunLeaseStoreProvider,
  WorkspaceOwnershipStoreProvider,
} from "../src/db-ports.ts";

function createHarness() {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-ledger-"));
  const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
  db.runMigrations();
  return { baseDir, db };
}

test("authoritative ledger preserves event receipt dedupe and context assignment", () => {
  const { baseDir, db } = createHarness();
  try {
    const receipts: EventReceiptStoreProvider["eventReceipts"] = db.eventReceipts;

    const first = receipts.insertEventReceipt({
      source: "linear-webhook",
      externalId: "delivery-1",
      eventType: "Issue.update",
      receivedAt: "2026-03-12T10:00:00.000Z",
      acceptanceStatus: "accepted",
      headersJson: "{}",
      payloadJson: "{\"ok\":true}",
    });
    const duplicate = receipts.insertEventReceipt({
      source: "linear-webhook",
      externalId: "delivery-1",
      eventType: "Issue.update",
      receivedAt: "2026-03-12T10:00:01.000Z",
      acceptanceStatus: "accepted",
    });

    assert.equal(first.inserted, true);
    assert.equal(duplicate.inserted, false);
    assert.equal(duplicate.id, first.id);

    receipts.assignEventReceiptContext(first.id, {
      projectId: "proj",
      linearIssueId: "issue-1",
    });
    receipts.markEventReceiptProcessed(first.id, "processed");

    const stored = receipts.getEventReceipt(first.id);
    assert.equal(stored?.acceptanceStatus, "duplicate");
    assert.equal(stored?.processingStatus, "processed");
    assert.equal(stored?.projectId, "proj");
    assert.equal(stored?.linearIssueId, "issue-1");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("authoritative ledger preserves issue control, workspace ownership, run leases, and obligations", () => {
  const { baseDir, db } = createHarness();
  try {
    const ledger: AuthoritativeLedgerStoreProvider["authoritativeLedger"] = db.authoritativeLedger;
    const issueControlStore: IssueControlStoreProvider["issueControl"] = db.issueControl;
    const workspaceStore: WorkspaceOwnershipStoreProvider["workspaceOwnership"] = db.workspaceOwnership;
    const runLeaseStore: RunLeaseStoreProvider["runLeases"] = db.runLeases;
    const obligationStore: ObligationStoreProvider["obligations"] = db.obligations;

    const receiptId = ledger.insertEventReceipt({
      source: "linear-webhook",
      externalId: "delivery-2",
      eventType: "Issue.update",
      receivedAt: "2026-03-12T11:00:00.000Z",
      acceptanceStatus: "accepted",
      projectId: "proj",
      linearIssueId: "issue-1",
    }).id;

    const issueControl = issueControlStore.upsertIssueControl({
      projectId: "proj",
      linearIssueId: "issue-1",
      desiredStage: "development",
      desiredReceiptId: receiptId,
      lifecycleStatus: "queued",
    });
    assert.equal(issueControlStore.listIssueControlsReadyForLaunch().length, 1);

    const workspace = workspaceStore.upsertWorkspaceOwnership({
      projectId: "proj",
      linearIssueId: "issue-1",
      branchName: "app/APP-1",
      worktreePath: "/tmp/worktrees/APP-1",
      status: "active",
    });

    const runLease = runLeaseStore.createRunLease({
      issueControlId: issueControl.id,
      projectId: "proj",
      linearIssueId: "issue-1",
      workspaceOwnershipId: workspace.id,
      stage: "development",
      triggerReceiptId: receiptId,
      status: "running",
    });

    issueControlStore.upsertIssueControl({
      projectId: "proj",
      linearIssueId: "issue-1",
      desiredStage: null,
      activeWorkspaceOwnershipId: workspace.id,
      activeRunLeaseId: runLease.id,
      serviceOwnedCommentId: "comment-1",
      lifecycleStatus: "running",
    });
    workspaceStore.upsertWorkspaceOwnership({
      projectId: "proj",
      linearIssueId: "issue-1",
      branchName: "app/APP-1",
      worktreePath: "/tmp/worktrees/APP-1",
      status: "active",
      currentRunLeaseId: runLease.id,
    });
    runLeaseStore.updateRunLeaseThread({
      runLeaseId: runLease.id,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const obligation = obligationStore.enqueueObligation({
      projectId: "proj",
      linearIssueId: "issue-1",
      kind: "deliver_turn_input",
      source: "linear-comment:1",
      payloadJson: "{\"body\":\"Please adjust the copy.\"}",
      runLeaseId: runLease.id,
      dedupeKey: "comment-1",
    });
    obligationStore.updateObligationRouting(obligation.id, { threadId: "thread-1", turnId: "turn-1" });
    obligationStore.markObligationStatus(obligation.id, "completed");

    runLeaseStore.finishRunLease({
      runLeaseId: runLease.id,
      status: "completed",
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const storedIssueControl = issueControlStore.getIssueControl("proj", "issue-1");
    const storedWorkspace = workspaceStore.getWorkspaceOwnershipForIssue("proj", "issue-1");
    const storedRunLease = runLeaseStore.getRunLease(runLease.id);
    const pendingObligations = obligationStore.listPendingObligations({ runLeaseId: runLease.id });

    assert.equal(storedIssueControl?.activeRunLeaseId, runLease.id);
    assert.equal(storedIssueControl?.serviceOwnedCommentId, "comment-1");
    assert.equal(storedWorkspace?.currentRunLeaseId, runLease.id);
    assert.equal(storedRunLease?.threadId, "thread-1");
    assert.equal(storedRunLease?.status, "completed");
    assert.equal(storedRunLease?.triggerReceiptId, receiptId);
    assert.equal(pendingObligations.length, 0);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("authoritative ledger dedupes obligations by run lease, kind, and dedupe key", () => {
  const { baseDir, db } = createHarness();
  try {
    const issueControl = db.issueControl.upsertIssueControl({
      projectId: "proj",
      linearIssueId: "issue-1",
      lifecycleStatus: "running",
    });
    const workspace = db.workspaceOwnership.upsertWorkspaceOwnership({
      projectId: "proj",
      linearIssueId: "issue-1",
      branchName: "app/APP-1",
      worktreePath: "/tmp/worktrees/APP-1",
      status: "active",
    });
    const runLease = db.runLeases.createRunLease({
      issueControlId: issueControl.id,
      projectId: "proj",
      linearIssueId: "issue-1",
      workspaceOwnershipId: workspace.id,
      stage: "development",
      status: "running",
    });

    const first = db.obligations.enqueueObligation({
      projectId: "proj",
      linearIssueId: "issue-1",
      kind: "deliver_turn_input",
      source: "linear-comment:1",
      payloadJson: "{\"body\":\"Please adjust the copy.\"}",
      runLeaseId: runLease.id,
      dedupeKey: "comment-1:hash-1",
    });
    const duplicate = db.obligations.enqueueObligation({
      projectId: "proj",
      linearIssueId: "issue-1",
      kind: "deliver_turn_input",
      source: "linear-comment:1",
      payloadJson: "{\"body\":\"Please adjust the copy.\"}",
      runLeaseId: runLease.id,
      dedupeKey: "comment-1:hash-1",
    });

    assert.equal(first.id, duplicate.id);
    assert.deepEqual(db.obligations.listPendingObligations({ runLeaseId: runLease.id }).map((entry) => entry.id), [first.id]);
    assert.equal(
      db.obligations.getObligationByDedupeKey({
        runLeaseId: runLease.id,
        kind: "deliver_turn_input",
        dedupeKey: "comment-1:hash-1",
      })?.id,
      first.id,
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("authoritative ledger preserves issue session history and last-opened tracking", () => {
  const { baseDir, db } = createHarness();
  try {
    const workspace = db.workspaceOwnership.upsertWorkspaceOwnership({
      projectId: "proj",
      linearIssueId: "issue-1",
      branchName: "app/APP-1",
      worktreePath: "/tmp/worktrees/APP-1",
      status: "active",
    });

    const session = db.issueSessions.upsertIssueSession({
      projectId: "proj",
      linearIssueId: "issue-1",
      workspaceOwnershipId: workspace.id,
      threadId: "thread-1",
      parentThreadId: "thread-parent",
      linkedAgentSessionId: "session-1",
      source: "stage_run",
    });
    const touched = db.issueSessions.touchIssueSession("thread-1");
    const listed = db.issueSessions.listIssueSessionsForIssue("proj", "issue-1");

    assert.equal(session.threadId, "thread-1");
    assert.equal(session.parentThreadId, "thread-parent");
    assert.equal(session.linkedAgentSessionId, "session-1");
    assert.ok(touched?.lastOpenedAt);
    assert.deepEqual(listed.map((entry) => entry.threadId), ["thread-1"]);
    assert.equal(db.issueSessions.getIssueSessionByThreadId("thread-1")?.workspaceOwnershipId, workspace.id);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("authoritative ledger only exposes pending obligations by default and claims them atomically", () => {
  const { baseDir, db } = createHarness();
  try {
    const issueControl = db.issueControl.upsertIssueControl({
      projectId: "proj",
      linearIssueId: "issue-2",
      lifecycleStatus: "running",
    });
    const workspace = db.workspaceOwnership.upsertWorkspaceOwnership({
      projectId: "proj",
      linearIssueId: "issue-2",
      branchName: "app/APP-2",
      worktreePath: "/tmp/worktrees/APP-2",
      status: "active",
    });
    const runLease = db.runLeases.createRunLease({
      issueControlId: issueControl.id,
      projectId: "proj",
      linearIssueId: "issue-2",
      workspaceOwnershipId: workspace.id,
      stage: "development",
      status: "running",
    });
    const obligation = db.obligations.enqueueObligation({
      projectId: "proj",
      linearIssueId: "issue-2",
      kind: "deliver_turn_input",
      source: "linear-comment:2",
      payloadJson: "{\"body\":\"Please retry.\"}",
      runLeaseId: runLease.id,
    });

    assert.deepEqual(db.obligations.listPendingObligations({ runLeaseId: runLease.id }).map((entry) => entry.id), [obligation.id]);
    assert.equal(
      db.obligations.claimPendingObligation(obligation.id, {
        runLeaseId: runLease.id,
        threadId: "thread-2",
        turnId: "turn-2",
      }),
      true,
    );
    assert.equal(db.obligations.claimPendingObligation(obligation.id), false);
    assert.deepEqual(db.obligations.listPendingObligations({ runLeaseId: runLease.id }).map((entry) => entry.id), []);
    assert.deepEqual(
      db.obligations.listPendingObligations({ runLeaseId: runLease.id, includeInProgress: true }).map((entry) => entry.status),
      ["in_progress"],
    );

    db.obligations.markObligationStatus(obligation.id, "failed", "payload invalid");

    assert.deepEqual(db.obligations.listPendingObligations({ runLeaseId: runLease.id }).map((entry) => entry.id), []);
    assert.deepEqual(
      db.obligations.listPendingObligations({ runLeaseId: runLease.id, includeInProgress: true }).map((entry) => entry.id),
      [],
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
