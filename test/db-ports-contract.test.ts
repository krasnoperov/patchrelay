import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import type {
  IssueWorkflowCoordinatorProvider,
  IssueWorkflowQueryStoreProvider,
  LinearInstallationStoreProvider,
  StageEventLogStoreProvider,
  WebhookEventStoreProvider,
} from "../src/db-ports.ts";

function createHarness() {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-db-ports-"));
  const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
  db.runMigrations();
  const stores = {
    webhookEvents: db.webhookEvents,
    workflowCoordinator: db.workflowCoordinator,
    issueWorkflows: db.issueWorkflows,
    stageEvents: db.stageEvents,
    linearInstallations: db.linearInstallations,
  };
  return { baseDir, db, stores };
}

test("db ports preserve webhook event insert, dedupe, assignment, and processing behavior", () => {
  const { baseDir, stores } = createHarness();
  try {
    const webhooks: WebhookEventStoreProvider["webhookEvents"] = stores.webhookEvents;
    const first = webhooks.insertWebhookEvent({
      webhookId: "delivery-1",
      receivedAt: "2026-03-11T10:00:00.000Z",
      eventType: "Issue.update",
      issueId: "issue-1",
      headersJson: "{}",
      payloadJson: "{\"ok\":true}",
      signatureValid: true,
      dedupeStatus: "accepted",
    });
    const duplicate = webhooks.insertWebhookEvent({
      webhookId: "delivery-1",
      receivedAt: "2026-03-11T10:00:01.000Z",
      eventType: "Issue.update",
      issueId: "issue-1",
      headersJson: "{}",
      payloadJson: "{\"ok\":true}",
      signatureValid: true,
      dedupeStatus: "accepted",
    });

    assert.equal(first.inserted, true);
    assert.equal(duplicate.inserted, false);
    assert.equal(duplicate.id, first.id);

    webhooks.assignWebhookProject(first.id, "proj");
    webhooks.markWebhookProcessed(first.id, "processed");
    const stored = webhooks.getWebhookEvent(first.id);

    assert.equal(stored?.projectId, "proj");
    assert.equal(stored?.processingStatus, "processed");
    assert.equal(stored?.dedupeStatus, "duplicate");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("db ports preserve Linear installation linking and OAuth state lifecycle", () => {
  const { baseDir, stores } = createHarness();
  try {
    const installations: LinearInstallationStoreProvider["linearInstallations"] = stores.linearInstallations;
    const installation = installations.upsertLinearInstallation({
      workspaceId: "workspace-1",
      workspaceName: "Workspace One",
      workspaceKey: "WS1",
      actorId: "patchrelay-app",
      actorName: "PatchRelay",
      accessTokenCiphertext: "ciphertext-1",
      refreshTokenCiphertext: "refresh-1",
      scopesJson: JSON.stringify(["read", "write"]),
      tokenType: "Bearer",
      expiresAt: "2026-03-12T10:00:00.000Z",
    });
    const linked = installations.linkProjectInstallation("proj", installation.id);
    const oauthState = installations.createOAuthState({
      provider: "linear",
      state: "state-1",
      projectId: "proj",
      redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
      actor: "app",
    });
    const finalized = installations.finalizeOAuthState({
      state: oauthState.state,
      status: "completed",
      installationId: installation.id,
    });

    assert.equal(linked.projectId, "proj");
    assert.equal(installations.getProjectInstallation("proj")?.installationId, installation.id);
    assert.equal(installations.getLinearInstallationForProject("proj")?.actorId, "patchrelay-app");
    assert.equal(finalized?.status, "completed");
    assert.equal(finalized?.installationId, installation.id);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("db ports preserve issue workflow execution and query behavior", () => {
  const { baseDir, db, stores } = createHarness();
  try {
    const workflowCoordinator: IssueWorkflowCoordinatorProvider["workflowCoordinator"] = stores.workflowCoordinator;
    const workflowQuery: IssueWorkflowQueryStoreProvider["issueWorkflows"] = stores.issueWorkflows;

    workflowCoordinator.recordDesiredStage({
      projectId: "proj",
      linearIssueId: "issue-1",
      issueKey: "APP-1",
      title: "Implement feature",
      issueUrl: "https://linear.app/example/APP-1",
      currentLinearState: "Start",
      desiredStage: "development",
      desiredWebhookId: "delivery-1",
      lastWebhookAt: "2026-03-11T10:00:00.000Z",
    });
    const readyIssues = [stores.issueWorkflows.getTrackedIssue("proj", "issue-1")].filter(
      (issue): issue is NonNullable<typeof issue> => Boolean(issue?.desiredStage),
    );
    assert.equal(readyIssues.length, 1);
    assert.equal(readyIssues[0]?.projectId, "proj");
    assert.equal(readyIssues[0]?.linearIssueId, "issue-1");

    const claim = workflowCoordinator.claimStageRun({
      projectId: "proj",
      linearIssueId: "issue-1",
      stage: "development",
      triggerWebhookId: "delivery-1",
      branchName: "app/APP-1",
      worktreePath: "/tmp/worktrees/APP-1",
      workflowFile: "/tmp/IMPLEMENTATION_WORKFLOW.md",
      promptText: "Ship it.",
    });
    assert.ok(claim);

    workflowCoordinator.updateStageRunThread({
      stageRunId: claim.stageRun.id,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    workflowCoordinator.finishStageRun({
      stageRunId: claim.stageRun.id,
      status: "completed",
      threadId: "thread-1",
      turnId: "turn-1",
      summaryJson: "{\"summary\":\"ok\"}",
      reportJson: "{\"status\":\"completed\"}",
    });

    const latestStage = workflowQuery.getLatestStageRunForIssue("proj", "issue-1");
    const overview = workflowQuery.getIssueOverview("APP-1");
    const session = db.issueSessions.getIssueSessionByThreadId("thread-1");

    assert.equal(latestStage?.threadId, "thread-1");
    assert.equal(latestStage?.status, "completed");
    assert.equal(overview?.issue.issueKey, "APP-1");
    assert.equal(overview?.workspace?.branchName, "app/APP-1");
    assert.equal(overview?.pipeline?.status, "completed");
    assert.equal(session?.runLeaseId, claim.stageRun.id);
    assert.equal(session?.source, "stage_run");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("db ports preserve thread event history for ledger-backed stage runs", () => {
  const { baseDir, stores } = createHarness();
  try {
    const workflowCoordinator: IssueWorkflowCoordinatorProvider["workflowCoordinator"] = stores.workflowCoordinator;
    const stageEvents: StageEventLogStoreProvider["stageEvents"] = stores.stageEvents;

    workflowCoordinator.recordDesiredStage({
      projectId: "proj",
      linearIssueId: "issue-1",
      issueKey: "APP-1",
      currentLinearState: "Start",
      desiredStage: "development",
      desiredWebhookId: "delivery-1",
      lastWebhookAt: "2026-03-11T10:00:00.000Z",
    });
    const claim = workflowCoordinator.claimStageRun({
      projectId: "proj",
      linearIssueId: "issue-1",
      stage: "development",
      triggerWebhookId: "delivery-1",
      branchName: "app/APP-1",
      worktreePath: "/tmp/worktrees/APP-1",
      workflowFile: "/tmp/IMPLEMENTATION_WORKFLOW.md",
      promptText: "Ship it.",
    });
    assert.ok(claim);

    const eventId = stageEvents.saveThreadEvent({
      stageRunId: claim.stageRun.id,
      threadId: "thread-1",
      turnId: "turn-1",
      method: "turn/started",
      eventJson: "{\"threadId\":\"thread-1\"}",
    });

    const events = stageEvents.listThreadEvents(claim.stageRun.id);

    assert.equal(events[0]?.id, eventId);
    assert.equal(events[0]?.method, "turn/started");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
