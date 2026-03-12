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
