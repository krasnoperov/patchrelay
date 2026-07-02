import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { ServiceStartupRecovery } from "../src/service-startup-recovery.ts";
import { IssueSessionLeaseService } from "../src/issue-session-lease-service.ts";
import type { AppConfig, LinearClient } from "../src/types.ts";

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
      path: ":memory:",
      wal: false,
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

test("startup recovery repairs re-delegated paused local work even without an agent session", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-startup-recovery-"));
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
      linearIssueId: "issue-redelegated",
      issueKey: "USE-REDO",
      title: "Resume paused implementation after missed re-delegation",
      delegatedToPatchRelay: false,
      factoryState: "implementing",
    });

    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const recovery = new ServiceStartupRecovery(
      config,
      db,
      {
        forProject: async () => ({
          getIssue: async () => ({
            id: "issue-redelegated",
            identifier: "USE-REDO",
            title: "Resume paused implementation after missed re-delegation",
            description: "",
            url: "https://linear.app/usertold/issue/USE-REDO",
            teamId: "team-use",
            teamKey: "USE",
            stateId: "state-start",
            stateName: "In Progress",
            stateType: "started",
            delegateId: "patchrelay-actor",
            delegateName: "PatchRelay",
            workflowStates: [],
            labelIds: [],
            labels: [],
            teamLabels: [],
            blockedBy: [],
            blocks: [],
          }),
        } satisfies Partial<LinearClient> as LinearClient),
      } as never,
      { syncSession: async () => undefined } as never,
      (projectId, issueId) => { enqueued.push({ projectId, issueId }); },
      pino({ enabled: false }),
      new IssueSessionLeaseService(db, pino({ enabled: false }), "test-worker"),
    );

    await recovery.recoverDelegatedIssueStateFromLinear();

    const issue = db.getIssue("usertold", "issue-redelegated");
    assert.equal(issue?.delegatedToPatchRelay, true);
    assert.equal(issue?.factoryState, "delegated");
    const task = db.workflowTasks.getTask("usertold", "issue-redelegated", "run:implementation");
    const authorityObservation = db.workflowObservations.listObservations("usertold", "issue-redelegated")
      .find((observation) => observation.type === "linear.delegated");
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-redelegated"), undefined);
    assert.equal(task?.runType, "implementation");
    assert.equal(task?.gateAction, "start");
    assert.ok(authorityObservation, "startup recovery should persist the live Linear delegation as workflow authority");
    assert.deepEqual(enqueued, [{ projectId: "usertold", issueId: "issue-redelegated" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("startup recovery discovers delegated Linear issues missing from the local database", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-startup-recovery-discover-"));
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

    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const recovery = new ServiceStartupRecovery(
      config,
      db,
      {
        forProject: async () => ({
          getIssue: async (issueId: string) => ({
            id: issueId,
            identifier: "USE-MISSED",
            title: "Recover missed delegated issue",
            description: "",
            url: "https://linear.app/usertold/issue/USE-MISSED",
            teamId: "USE",
            teamKey: "USE",
            stateId: "state-backlog",
            stateName: "Backlog",
            stateType: "backlog",
            delegateId: "patchrelay-actor",
            delegateName: "PatchRelay",
            workflowStates: [],
            labelIds: [],
            labels: [],
            teamLabels: [],
            blockedBy: [],
            blocks: [],
          }),
          listIssuesDelegatedTo: async () => [
            {
              id: "issue-missed",
              identifier: "USE-MISSED",
              title: "Recover missed delegated issue",
              description: "",
              url: "https://linear.app/usertold/issue/USE-MISSED",
              teamId: "USE",
              teamKey: "USE",
              stateId: "state-backlog",
              stateName: "Backlog",
              stateType: "backlog",
              delegateId: "patchrelay-actor",
              delegateName: "PatchRelay",
              workflowStates: [],
              labelIds: [],
              labels: [],
              teamLabels: [],
              blockedBy: [],
              blocks: [],
            },
          ],
        } satisfies Partial<LinearClient> as LinearClient),
      } as never,
      { syncSession: async () => undefined } as never,
      (projectId, issueId) => { enqueued.push({ projectId, issueId }); },
      pino({ enabled: false }),
      new IssueSessionLeaseService(db, pino({ enabled: false }), "test-worker"),
    );

    await recovery.recoverDelegatedIssueStateFromLinear();

    const issue = db.getIssue("usertold", "issue-missed");
    assert.equal(issue?.issueKey, "USE-MISSED");
    assert.equal(issue?.delegatedToPatchRelay, true);
    assert.equal(issue?.factoryState, "delegated");
    const task = db.workflowTasks.getTask("usertold", "issue-missed", "run:implementation");
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-missed"), undefined);
    assert.equal(task?.runType, "implementation");
    assert.equal(task?.gateAction, "start");
    assert.deepEqual(enqueued, [{ projectId: "usertold", issueId: "issue-missed" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("startup recovery re-queues delegated requested-changes work after a restart", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-startup-recovery-reactive-pr-"));
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
      linearIssueId: "issue-reactive-review",
      issueKey: "USE-REVIEW",
      title: "Resume requested-changes repair after restart",
      delegatedToPatchRelay: false,
      factoryState: "pr_open",
      prNumber: 33,
      prState: "open",
      prHeadSha: "sha-review",
      prReviewState: "changes_requested",
      prCheckStatus: "success",
    });

    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const recovery = new ServiceStartupRecovery(
      config,
      db,
      {
        forProject: async () => ({
          getIssue: async () => ({
            id: "issue-reactive-review",
            identifier: "USE-REVIEW",
            title: "Resume requested-changes repair after restart",
            description: "",
            url: "https://linear.app/usertold/issue/USE-REVIEW",
            teamId: "team-use",
            teamKey: "USE",
            stateId: "state-review",
            stateName: "In Review",
            stateType: "started",
            delegateId: "patchrelay-actor",
            delegateName: "PatchRelay",
            workflowStates: [],
            labelIds: [],
            labels: [],
            teamLabels: [],
            blockedBy: [],
            blocks: [],
          }),
        } satisfies Partial<LinearClient> as LinearClient),
      } as never,
      { syncSession: async () => undefined } as never,
      (projectId, issueId) => { enqueued.push({ projectId, issueId }); },
      pino({ enabled: false }),
      new IssueSessionLeaseService(db, pino({ enabled: false }), "test-worker"),
    );

    await recovery.recoverDelegatedIssueStateFromLinear();

    const issue = db.getIssue("usertold", "issue-reactive-review");
    const task = db.workflowTasks.getTask("usertold", "issue-reactive-review", "run:review_fix");
    assert.equal(issue?.delegatedToPatchRelay, true);
    assert.equal(issue?.factoryState, "changes_requested");
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-reactive-review"), undefined);
    assert.equal(task?.runType, "review_fix");
    assert.equal(task?.gateAction, "start");
    assert.deepEqual(enqueued, [{ projectId: "usertold", issueId: "issue-reactive-review" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("startup recovery does not resync idle paused issues just because they still have an agent session", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-startup-recovery-idle-session-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-paused-session",
      issueKey: "USE-PAUSED",
      title: "Paused requested-changes issue",
      delegatedToPatchRelay: false,
      factoryState: "changes_requested",
      agentSessionId: "session-paused",
    });

    const syncCalls: Array<Record<string, unknown>> = [];
    const recovery = new ServiceStartupRecovery(
      config,
      db,
      { forProject: async () => undefined } as never,
      {
        syncSession: async (issue, options) => {
          syncCalls.push({
            issueKey: issue.issueKey,
            ...(options?.activeRunType ? { activeRunType: options.activeRunType } : {}),
          });
        },
      } as never,
      () => undefined,
      pino({ enabled: false }),
      new IssueSessionLeaseService(db, pino({ enabled: false }), "test-worker"),
    );

    await recovery.syncKnownAgentSessions();

    assert.deepEqual(syncCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("startup recovery does not scan webhook history for idle issues without active runs", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-startup-recovery-no-idle-webhook-scan-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-idle-no-session",
      issueKey: "USE-IDLE",
      title: "Idle issue without an agent session",
      delegatedToPatchRelay: true,
      factoryState: "changes_requested",
    });

    let webhookHistoryLookups = 0;
    db.webhookEvents.findLatestAgentSessionIdForIssue = () => {
      webhookHistoryLookups += 1;
      return "session-from-history";
    };

    const recovery = new ServiceStartupRecovery(
      config,
      db,
      { forProject: async () => undefined } as never,
      { syncSession: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
      new IssueSessionLeaseService(db, pino({ enabled: false }), "test-worker"),
    );

    await recovery.syncKnownAgentSessions();

    assert.equal(webhookHistoryLookups, 0);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("startup recovery still resyncs active runs with agent sessions", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-startup-recovery-active-session-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-active-session",
      issueKey: "USE-ACTIVE",
      title: "Actively running issue",
      delegatedToPatchRelay: true,
      factoryState: "implementing",
      agentSessionId: "session-active",
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
    });

    const syncCalls: Array<Record<string, unknown>> = [];
    const recovery = new ServiceStartupRecovery(
      config,
      db,
      { forProject: async () => undefined } as never,
      {
        syncSession: async (syncedIssue, options) => {
          syncCalls.push({
            issueKey: syncedIssue.issueKey,
            ...(options?.activeRunType ? { activeRunType: options.activeRunType } : {}),
          });
        },
      } as never,
      () => undefined,
      pino({ enabled: false }),
      new IssueSessionLeaseService(db, pino({ enabled: false }), "test-worker"),
    );

    await recovery.syncKnownAgentSessions();

    assert.deepEqual(syncCalls, [{ issueKey: "USE-ACTIVE", activeRunType: "implementation" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("startup recovery drains legacy pending_run_type rows into durable workflow tasks (S6)", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-startup-recovery-drain-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    // A pre-S6 row that still carries the legacy pending columns.
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-drain",
      issueKey: "USE-DRAIN",
      delegatedToPatchRelay: true,
      factoryState: "changes_requested",
      prNumber: 900,
      prState: "open",
      prHeadSha: "sha-drain",
      prReviewState: "changes_requested",
      lastBlockingReviewHeadSha: "sha-drain",
      pendingRunType: "review_fix",
      pendingRunContextJson: JSON.stringify({
        requestedChangesHeadSha: "sha-drain",
        wakeReason: "review_changes_requested",
      }),
    });

    const recovery = new ServiceStartupRecovery(
      config,
      db,
      { forProject: async () => undefined } as never,
      { syncSession: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
      new IssueSessionLeaseService(db, pino({ enabled: false }), "test-worker"),
    );

    recovery.reconcileKnownWorkflowTasks();

    // Columns drained…
    const drained = db.getIssue("usertold", "issue-drain");
    assert.equal(drained?.pendingRunType, undefined);
    assert.equal(drained?.pendingRunContextJson, undefined);
    // …and the equivalent runnable workflow task exists.
    const tasks = db.workflowTasks.listOpenRunnableTasks("usertold")
      .filter((task) => task.subjectId === "issue-drain" && task.taskId === "run:review_fix");
    assert.equal(tasks.length, 1);

    // A second sweep is a no-op: no columns to drain, task unchanged.
    recovery.reconcileKnownWorkflowTasks();
    const afterSecond = db.getIssue("usertold", "issue-drain");
    assert.equal(afterSecond?.pendingRunType, undefined);
    const stillOne = db.workflowTasks.listOpenRunnableTasks("usertold")
      .filter((task) => task.subjectId === "issue-drain" && task.taskId === "run:review_fix");
    assert.equal(stillOne.length, 1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
