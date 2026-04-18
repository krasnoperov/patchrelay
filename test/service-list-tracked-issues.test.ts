import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { PatchRelayService } from "../src/service.ts";
import type { AppConfig } from "../src/types.ts";

function createConfig(baseDir: string): AppConfig {
  return {
    server: {
      bind: "127.0.0.1",
      port: 8787,
      healthPath: "/health",
      readinessPath: "/ready",
    },
    ingress: {
      linearWebhookPath: "/webhooks/linear",
      githubWebhookPath: "/webhooks/github",
      maxBodyBytes: 262144,
      maxTimestampSkewSeconds: 60,
    },
    logging: {
      level: "info",
      format: "logfmt",
      filePath: path.join(baseDir, "patchrelay.log"),
    },
    database: {
      path: path.join(baseDir, "patchrelay.sqlite"),
      wal: true,
    },
    linear: {
      webhookSecret: "secret",
      graphqlUrl: "https://linear.example/graphql",
      oauth: {
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
        scopes: ["read", "write"],
        actor: "user",
      },
      tokenEncryptionKey: "test-encryption-key",
    },
    operatorApi: {
      enabled: false,
    },
    runner: {
      gitBin: "git",
      codex: {
        bin: "node",
        args: ["app-server"],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        persistExtendedHistory: false,
      },
    },
    projects: [
      {
        id: "usertold",
        repoPath: path.join(baseDir, "repo"),
        worktreeRoot: path.join(baseDir, "worktrees"),
        issueKeyPrefixes: ["USE"],
        linearTeamIds: ["USE"],
        allowLabels: [],
        triggerEvents: ["statusChanged"],
        branchPrefix: "use",
        github: {
          repoFullName: "owner/repo",
        },
      },
    ],
    secretSources: {},
  };
}

test("listTrackedIssues suppresses stale interrupted notes while a run is active", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-service-list-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const service = new PatchRelayService(
      config,
      db,
      {
        on: () => undefined,
        readThread: async () => ({ id: "thread-1", turns: [] }),
      } as never,
      undefined,
      pino({ enabled: false }),
    );

    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-1",
      title: "Active queue repair",
      currentLinearState: "In Review",
      factoryState: "repairing_queue",
      prNumber: 1,
      prReviewState: "approved",
      prCheckStatus: "failure",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "queue_repair",
    });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
      factoryState: "repairing_queue",
    });
    db.connection.prepare(`
      UPDATE issue_sessions
      SET summary_text = ?, session_state = ?, active_run_id = ?
      WHERE project_id = ? AND linear_issue_id = ?
    `).run(
      "Codex turn was interrupted",
      "running",
      run.id,
      issue.projectId,
      issue.linearIssueId,
    );

    const tracked = service.listTrackedIssues().find((entry) => entry.issueKey === "USE-1");
    assert.ok(tracked);
    assert.equal(tracked.activeRunType, "queue_repair");
    assert.equal(tracked.waitingReason, "PatchRelay is actively working");
    assert.equal(tracked.statusNote, undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("listTrackedIssues suppresses stale zombie notes while a run is active", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-service-list-zombie-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const service = new PatchRelayService(
      config,
      db,
      {
        on: () => undefined,
        readThread: async () => ({ id: "thread-1", turns: [] }),
      } as never,
      undefined,
      pino({ enabled: false }),
    );

    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-zombie",
      issueKey: "USE-Z",
      title: "Active implementation after zombie recovery",
      currentLinearState: "In Progress",
      factoryState: "implementing",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
      factoryState: "implementing",
    });
    db.connection.prepare(`
      UPDATE issue_sessions
      SET summary_text = ?, session_state = ?, active_run_id = ?
      WHERE project_id = ? AND linear_issue_id = ?
    `).run(
      "Zombie: never started (no thread after restart)",
      "running",
      run.id,
      issue.projectId,
      issue.linearIssueId,
    );

    const tracked = service.listTrackedIssues().find((entry) => entry.issueKey === "USE-Z");
    assert.ok(tracked);
    assert.equal(tracked.activeRunType, "implementation");
    assert.equal(tracked.waitingReason, "PatchRelay is actively working");
    assert.equal(tracked.statusNote, undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("listTrackedIssues ordering ignores lease heartbeats", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-service-list-lease-order-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const service = new PatchRelayService(
      config,
      db,
      {
        on: () => undefined,
        readThread: async () => ({ id: "thread-1", turns: [] }),
      } as never,
      undefined,
      pino({ enabled: false }),
    );

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-1",
      title: "Older visible update",
      factoryState: "delegated",
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-2",
      issueKey: "USE-2",
      title: "Newer visible update",
      factoryState: "delegated",
    });

    db.connection.prepare(`
      UPDATE issue_sessions
      SET display_updated_at = ?, updated_at = ?
      WHERE project_id = ? AND linear_issue_id = ?
    `).run("2026-04-01T09:00:00.000Z", "2026-04-01T09:00:00.000Z", "usertold", "issue-1");
    db.connection.prepare(`
      UPDATE issue_sessions
      SET display_updated_at = ?, updated_at = ?
      WHERE project_id = ? AND linear_issue_id = ?
    `).run("2026-04-01T10:00:00.000Z", "2026-04-01T10:00:00.000Z", "usertold", "issue-2");

    db.issueSessions.acquireIssueSessionLease({
      projectId: "usertold",
      linearIssueId: "issue-1",
      leaseId: "lease-1",
      workerId: "worker-1",
      leasedUntil: "2026-04-01T11:00:00.000Z",
      now: "2026-04-01T10:30:00.000Z",
    });
    db.issueSessions.renewIssueSessionLease({
      projectId: "usertold",
      linearIssueId: "issue-1",
      leaseId: "lease-1",
      leasedUntil: "2026-04-01T11:30:00.000Z",
      now: "2026-04-01T10:45:00.000Z",
    });

    const listed = service.listTrackedIssues().map((entry) => entry.issueKey);
    assert.deepEqual(listed.slice(0, 2), ["USE-2", "USE-1"]);
    assert.equal(db.issueSessions.getIssueSession("usertold", "issue-1")?.updatedAt, "2026-04-01T10:45:00.000Z");
    assert.equal(db.issueSessions.getIssueSession("usertold", "issue-1")?.displayUpdatedAt, "2026-04-01T09:00:00.000Z");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("listTrackedIssues ordering follows visible session updates", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-service-list-visible-order-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const service = new PatchRelayService(
      config,
      db,
      {
        on: () => undefined,
        readThread: async () => ({ id: "thread-1", turns: [] }),
      } as never,
      undefined,
      pino({ enabled: false }),
    );

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-1",
      title: "Will become newest",
      factoryState: "delegated",
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-2",
      issueKey: "USE-2",
      title: "Starts newest",
      factoryState: "delegated",
    });

    db.connection.prepare(`
      UPDATE issue_sessions
      SET display_updated_at = ?, updated_at = ?
      WHERE project_id = ? AND linear_issue_id = ?
    `).run("2026-04-01T09:00:00.000Z", "2026-04-01T09:00:00.000Z", "usertold", "issue-1");
    db.connection.prepare(`
      UPDATE issue_sessions
      SET display_updated_at = ?, updated_at = ?
      WHERE project_id = ? AND linear_issue_id = ?
    `).run("2026-04-01T10:00:00.000Z", "2026-04-01T10:00:00.000Z", "usertold", "issue-2");

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      factoryState: "implementing",
      activeRunId: 42,
    });

    const listed = service.listTrackedIssues();
    assert.equal(listed[0]?.issueKey, "USE-1");
    assert.equal(listed[0]?.updatedAt, db.issueSessions.getIssueSession("usertold", "issue-1")?.displayUpdatedAt);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("listTrackedIssues surfaces actionable stop guidance for awaiting_input issues", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-service-list-awaiting-input-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const service = new PatchRelayService(
      config,
      db,
      {
        on: () => undefined,
        readThread: async () => ({ id: "thread-1", turns: [] }),
      } as never,
      undefined,
      pino({ enabled: false }),
    );

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-2",
      issueKey: "USE-2",
      title: "Stopped implementation",
      currentLinearState: "In Progress",
      factoryState: "awaiting_input",
      agentSessionId: "session-2",
    });
    db.issueSessions.appendIssueSessionEvent({
      projectId: "usertold",
      linearIssueId: "issue-2",
      eventType: "stop_requested",
      dedupeKey: "stop_requested:issue-2",
    });

    const tracked = service.listTrackedIssues().find((entry) => entry.issueKey === "USE-2");
    assert.ok(tracked);
    assert.equal(tracked.waitingReason, "Waiting on operator input");
    assert.equal(tracked.statusNote, "Operator stopped the run. Use retry or delegate again to resume.");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("service start recovers delegated blocked issues from paused local-work state", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-service-startup-recover-blocked-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const installation = db.linearInstallations.upsertLinearInstallation({
      workspaceId: "workspace-1",
      actorId: "patchrelay-actor",
      accessTokenCiphertext: "ciphertext",
      scopesJson: "[]",
    });
    db.linearInstallations.linkProjectInstallation("usertold", installation.id);

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-3",
      issueKey: "USE-3",
      title: "Blocked delegated issue",
      currentLinearState: "Backlog",
      factoryState: "implementing",
      agentSessionId: "session-3",
    });

    const service = new PatchRelayService(
      config,
      db,
      {
        start: async () => undefined,
        stop: async () => undefined,
        isStarted: () => true,
        on: () => undefined,
        readThread: async () => ({ id: "thread-1", turns: [] }),
      } as never,
      {
        forProject: async () => ({
          getIssue: async () => ({
            id: "issue-3",
            identifier: "USE-3",
            title: "Blocked delegated issue",
            description: "",
            url: "https://linear.app/usertold/issue/USE-3",
            teamId: "team-use",
            teamKey: "USE",
            stateId: "state-backlog",
            stateName: "Backlog",
            stateType: "unstarted",
            delegateId: "patchrelay-actor",
            delegateName: "PatchRelay",
            workflowStates: [],
            labelIds: [],
            labels: [],
            teamLabels: [],
            blockedBy: [{
              id: "issue-blocker",
              identifier: "USE-1",
              title: "Blocking issue",
              stateName: "In Progress",
              stateType: "started",
            }],
            blocks: [],
          }),
          updateAgentSession: async () => ({ id: "session-3" }),
          upsertIssueComment: async () => ({ id: "comment-3", body: "ok" }),
          createAgentActivity: async () => ({ id: "activity-3" }),
        }),
      } as never,
      pino({ enabled: false }),
    );

    await service.start();
    await delay(0);
    await delay(0);

    const tracked = service.listTrackedIssues().find((entry) => entry.issueKey === "USE-3");
    assert.ok(tracked);
    assert.equal(tracked.factoryState, "delegated");
    assert.equal(tracked.blockedByCount, 1);
    assert.deepEqual(tracked.blockedByKeys, ["USE-1"]);
    assert.equal(tracked.waitingReason, "Blocked by USE-1");
    await service.stop();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("listTrackedIssues keeps undelegated local work paused instead of ready or active", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-service-list-paused-local-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const service = new PatchRelayService(
      config,
      db,
      {
        on: () => undefined,
        readThread: async () => ({ id: "thread-1", turns: [] }),
      } as never,
      undefined,
      pino({ enabled: false }),
    );

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-paused-local",
      issueKey: "USE-PAUSED",
      title: "Paused local implementation",
      delegatedToPatchRelay: false,
      currentLinearState: "Backlog",
      factoryState: "implementing",
    });

    const tracked = service.listTrackedIssues().find((entry) => entry.issueKey === "USE-PAUSED");
    assert.ok(tracked);
    assert.equal(tracked.delegatedToPatchRelay, false);
    assert.equal(tracked.readyForExecution, false);
    assert.equal(tracked.activeRunType, undefined);
    assert.equal(tracked.waitingReason, "PatchRelay automation is paused because the issue is undelegated");
    assert.equal(tracked.statusNote, "PatchRelay automation is paused because the issue is undelegated");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("service start preserves delegated completion-check questions in awaiting_input", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-service-startup-preserve-question-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const installation = db.linearInstallations.upsertLinearInstallation({
      workspaceId: "workspace-1",
      actorId: "patchrelay-actor",
      accessTokenCiphertext: "ciphertext",
      scopesJson: "[]",
    });
    db.linearInstallations.linkProjectInstallation("usertold", installation.id);

    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-3b",
      issueKey: "USE-3B",
      title: "Needs decision before continuing",
      currentLinearState: "Backlog",
      factoryState: "awaiting_input",
      agentSessionId: "session-3b",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "Ship it",
    });
    db.runs.finishRun(run.id, {
      status: "completed",
      summaryJson: JSON.stringify({ latestAssistantMessage: "I need a product decision before continuing." }),
    });
    db.runs.saveCompletionCheck(run.id, {
      outcome: "needs_input",
      summary: "PatchRelay needs a product decision before continuing.",
      question: "Should the workflow prefer the compact layout?",
      why: "Both options are plausible, and the issue does not specify which one to ship.",
      recommendedReply: "Use the compact layout.",
    });

    const service = new PatchRelayService(
      config,
      db,
      {
        start: async () => undefined,
        stop: async () => undefined,
        isStarted: () => true,
        on: () => undefined,
        readThread: async () => ({ id: "thread-1", turns: [] }),
      } as never,
      {
        forProject: async () => ({
          getIssue: async () => ({
            id: "issue-3b",
            identifier: "USE-3B",
            title: "Needs decision before continuing",
            description: "",
            url: "https://linear.app/usertold/issue/USE-3B",
            teamId: "team-use",
            teamKey: "USE",
            stateId: "state-backlog",
            stateName: "Backlog",
            stateType: "unstarted",
            delegateId: "patchrelay-actor",
            delegateName: "PatchRelay",
            workflowStates: [],
            labelIds: [],
            labels: [],
            teamLabels: [],
            blockedBy: [],
            blocks: [],
          }),
          updateAgentSession: async () => ({ id: "session-3b" }),
          upsertIssueComment: async () => ({ id: "comment-3b", body: "ok" }),
          createAgentActivity: async () => ({ id: "activity-3b" }),
        }),
      } as never,
      pino({ enabled: false }),
    );

    await service.start();

    const tracked = service.listTrackedIssues().find((entry) => entry.issueKey === "USE-3B");
    assert.ok(tracked);
    assert.equal(tracked.factoryState, "awaiting_input");
    assert.equal(tracked.waitingReason, "Waiting on operator input");
    assert.equal(tracked.statusNote, "Should the workflow prefer the compact layout?");
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-3b"), undefined);
    await service.stop();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("listTrackedIssues does not mark downstream waiting issues as ready just because legacy pending state exists", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-service-list-downstream-ready-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const service = new PatchRelayService(
      config,
      db,
      {
        on: () => undefined,
        readThread: async () => ({ id: "thread-1", turns: [] }),
      } as never,
      undefined,
      pino({ enabled: false }),
    );

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-queue",
      issueKey: "USE-QUEUE",
      title: "Waiting downstream",
      currentLinearState: "In Review",
      factoryState: "awaiting_queue",
      pendingRunType: "implementation",
      prNumber: 22,
      prReviewState: "approved",
      prCheckStatus: "success",
    });

    const tracked = service.listTrackedIssues().find((entry) => entry.issueKey === "USE-QUEUE");
    assert.ok(tracked);
    assert.equal(tracked.waitingReason, "PatchRelay work is done; waiting on downstream review/merge automation");
    assert.equal(tracked.readyForExecution, false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("listTrackedIssues does not mark awaiting-review issues as ready just because legacy pending state exists", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-service-list-awaiting-review-ready-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const service = new PatchRelayService(
      config,
      db,
      {
        on: () => undefined,
        readThread: async () => ({ id: "thread-1", turns: [] }),
      } as never,
      undefined,
      pino({ enabled: false }),
    );

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-review",
      issueKey: "USE-REVIEW",
      title: "Awaiting review",
      currentLinearState: "In Review",
      factoryState: "pr_open",
      pendingRunType: "implementation",
      prNumber: 21,
      prState: "open",
      prReviewState: "review_required",
      prCheckStatus: "success",
    });

    const tracked = service.listTrackedIssues().find((entry) => entry.issueKey === "USE-REVIEW");
    assert.ok(tracked);
    assert.equal(tracked.waitingReason, "Waiting on external review");
    assert.equal(tracked.readyForExecution, false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("listTrackedIssues does not treat closed PRs on done issues as awaiting external review", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-service-list-closed-pr-done-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const service = new PatchRelayService(
      config,
      db,
      {
        on: () => undefined,
        readThread: async () => ({ id: "thread-1", turns: [] }),
      } as never,
      undefined,
      pino({ enabled: false }),
    );

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-closed-done",
      issueKey: "USE-CLOSED",
      title: "Closed report PR",
      currentLinearState: "Done",
      currentLinearStateType: "completed",
      factoryState: "done",
      prNumber: 193,
      prState: "closed",
      prReviewState: "commented",
      prCheckStatus: "success",
    });

    const tracked = service.listTrackedIssues().find((entry) => entry.issueKey === "USE-CLOSED");
    assert.ok(tracked);
    assert.equal(tracked.prState, "closed");
    assert.equal(tracked.waitingReason, "PatchRelay work is complete");
    assert.equal(tracked.readyForExecution, false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
