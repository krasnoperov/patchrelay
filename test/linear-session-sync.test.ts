import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { LinearSessionSync } from "../src/linear-session-sync.ts";
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
        id: "krasnoperov/ballony-i-nasosy",
        repoPath: path.join(baseDir, "repo"),
        worktreeRoot: path.join(baseDir, "worktrees"),
        issueKeyPrefixes: ["TST"],
        linearProjectIds: ["project-tst"],
        allowLabels: [],
        triggerEvents: ["delegateChanged", "statusChanged", "agentSessionCreated", "agentPrompted", "commentCreated", "commentUpdated"],
        branchPrefix: "tst",
        github: {
          repoFullName: "krasnoperov/ballony-i-nasosy",
        },
      },
    ],
    secretSources: {},
  };
}

test("syncSession mirrors failure state into a visible Linear status comment", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-linear-sync-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "krasnoperov/ballony-i-nasosy",
      linearIssueId: "issue-tst-1",
      issueKey: "TST-1",
      title: "Replace the placeholder local draft model with a real game session schema",
      factoryState: "failed",
      agentSessionId: "session-1",
      currentLinearState: "In Progress",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.runs.finishRun(run.id, {
      status: "failed",
      failureReason: "Implementation completed without opening a PR",
    });

    const sessionUpdates: Array<Record<string, unknown>> = [];
    const commentUpdates: Array<Record<string, unknown>> = [];
    const linear: Partial<LinearClient> = {
      updateAgentSession: async (params) => {
        sessionUpdates.push(params as unknown as Record<string, unknown>);
        return { id: params.agentSessionId };
      },
      upsertIssueComment: async (params) => {
        commentUpdates.push(params as unknown as Record<string, unknown>);
        return { id: "comment-1", body: params.body };
      },
      createAgentActivity: async () => ({ id: "activity-1" }),
      getIssue: async () => { throw new Error("not used"); },
      setIssueState: async () => { throw new Error("not used"); },
      updateIssueLabels: async () => { throw new Error("not used"); },
      getActorProfile: async () => ({ actorId: "patchrelay-actor" }),
      getWorkspaceCatalog: async () => ({ workspace: {}, teams: [], projects: [] }),
    };

    const sync = new LinearSessionSync(
      config,
      db,
      { forProject: async () => linear as LinearClient },
      pino({ enabled: false }),
    );

    await sync.syncSession(db.getIssue(issue.projectId, issue.linearIssueId)!, { activeRunType: "implementation" });

    assert.equal(sessionUpdates.length, 1);
    assert.equal(commentUpdates.length, 1);
    assert.equal(commentUpdates[0]?.commentId, undefined);
    assert.match(String(commentUpdates[0]?.body), /Needs operator intervention/);
    assert.doesNotMatch(String(commentUpdates[0]?.body), /Running implementation/);
    assert.match(String(commentUpdates[0]?.body), /Latest run: implementation failed/);
    assert.match(String(commentUpdates[0]?.body), /Failure: Implementation completed without opening a PR/);
    assert.equal(db.getIssue(issue.projectId, issue.linearIssueId)?.statusCommentId, "comment-1");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("syncSession prefers the intervention reason over the last assistant summary for escalated issues", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-linear-sync-escalated-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "krasnoperov/ballony-i-nasosy",
      linearIssueId: "issue-tst-escalated",
      issueKey: "TST-30",
      title: "Rebuild `/app` as history, archive, and recovery shell",
      factoryState: "escalated",
      agentSessionId: "session-escalated",
      currentLinearState: "In Review",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
    });
    db.runs.finishRun(run.id, {
      status: "completed",
      summaryJson: JSON.stringify({
        assistantMessages: [
          "Aligned the remaining route copy so `/`, `/game`, and `/app` now tell the same story.",
        ],
      }),
      failureReason: "CI repair budget exhausted (3 attempts)",
    });

    const commentUpdates: Array<Record<string, unknown>> = [];
    const linear: Partial<LinearClient> = {
      updateAgentSession: async (params) => ({ id: params.agentSessionId }),
      upsertIssueComment: async (params) => {
        commentUpdates.push(params as unknown as Record<string, unknown>);
        return { id: "comment-escalated", body: params.body };
      },
      createAgentActivity: async () => ({ id: "activity-escalated" }),
      getIssue: async () => { throw new Error("not used"); },
      setIssueState: async () => { throw new Error("not used"); },
      updateIssueLabels: async () => { throw new Error("not used"); },
      getActorProfile: async () => ({ actorId: "patchrelay-actor" }),
      getWorkspaceCatalog: async () => ({ workspace: {}, teams: [], projects: [] }),
    };

    const sync = new LinearSessionSync(
      config,
      db,
      { forProject: async () => linear as LinearClient },
      pino({ enabled: false }),
    );

    await sync.syncSession(db.getIssue(issue.projectId, issue.linearIssueId)!);

    assert.equal(commentUpdates.length, 1);
    assert.match(String(commentUpdates[0]?.body), /Needs operator intervention/);
    assert.match(String(commentUpdates[0]?.body), /Action needed: CI repair budget exhausted \(3 attempts\)/);
    assert.doesNotMatch(String(commentUpdates[0]?.body), /Aligned the remaining route copy/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("syncSession updates the existing visible Linear status comment even without an agent session id", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-linear-sync-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "krasnoperov/ballony-i-nasosy",
      linearIssueId: "issue-tst-3",
      issueKey: "TST-3",
      title: "Implement scoring for correct guesses",
      factoryState: "failed",
      statusCommentId: "comment-9",
    });

    const sessionUpdates: Array<Record<string, unknown>> = [];
    const commentUpdates: Array<Record<string, unknown>> = [];
    const linear: Partial<LinearClient> = {
      updateAgentSession: async (params) => {
        sessionUpdates.push(params as unknown as Record<string, unknown>);
        return { id: params.agentSessionId };
      },
      upsertIssueComment: async (params) => {
        commentUpdates.push(params as unknown as Record<string, unknown>);
        return { id: String(params.commentId ?? "comment-9"), body: params.body };
      },
      createAgentActivity: async () => ({ id: "activity-1" }),
      getIssue: async () => { throw new Error("not used"); },
      setIssueState: async () => { throw new Error("not used"); },
      updateIssueLabels: async () => { throw new Error("not used"); },
      getActorProfile: async () => ({ actorId: "patchrelay-actor" }),
      getWorkspaceCatalog: async () => ({ workspace: {}, teams: [], projects: [] }),
    };

    const sync = new LinearSessionSync(
      config,
      db,
      { forProject: async () => linear as LinearClient },
      pino({ enabled: false }),
    );

    await sync.syncSession(db.getIssue(issue.projectId, issue.linearIssueId)!);

    assert.equal(sessionUpdates.length, 0);
    assert.equal(commentUpdates.length, 1);
    assert.equal(commentUpdates[0]?.commentId, "comment-9");
    assert.match(String(commentUpdates[0]?.body), /Needs operator intervention/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("syncSession includes actionable input text for awaiting_input sessions", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-linear-sync-awaiting-input-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "krasnoperov/ballony-i-nasosy",
      linearIssueId: "issue-tst-7",
      issueKey: "TST-7",
      title: "Awaiting operator follow-up",
      factoryState: "awaiting_input",
      agentSessionId: "session-7",
    });
    db.issueSessions.appendIssueSessionEvent({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType: "stop_requested",
      dedupeKey: "stop_requested:issue-tst-7",
    });

    const commentUpdates: Array<Record<string, unknown>> = [];
    const linear: Partial<LinearClient> = {
      updateAgentSession: async (params) => ({ id: params.agentSessionId }),
      upsertIssueComment: async (params) => {
        commentUpdates.push(params as unknown as Record<string, unknown>);
        return { id: "comment-7", body: params.body };
      },
      createAgentActivity: async () => ({ id: "activity-7" }),
      getIssue: async () => { throw new Error("not used"); },
      setIssueState: async () => { throw new Error("not used"); },
      updateIssueLabels: async () => { throw new Error("not used"); },
      getActorProfile: async () => ({ actorId: "patchrelay-actor" }),
      getWorkspaceCatalog: async () => ({ workspace: {}, teams: [], projects: [] }),
    };

    const sync = new LinearSessionSync(
      config,
      db,
      { forProject: async () => linear as LinearClient },
      pino({ enabled: false }),
    );

    await sync.syncSession(db.getIssue(issue.projectId, issue.linearIssueId)!);

    assert.equal(commentUpdates.length, 1);
    assert.match(String(commentUpdates[0]?.body), /Waiting: Waiting on operator input/);
    assert.match(String(commentUpdates[0]?.body), /Input needed: Operator stopped the run\. Use retry or delegate again to resume\./);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("syncSession does not write a routine visible issue comment for healthy agent-session runs", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-linear-sync-healthy-agent-session-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "krasnoperov/ballony-i-nasosy",
      linearIssueId: "issue-tst-20",
      issueKey: "TST-20",
      title: "Parallelize verify into smaller jobs behind one clear required gate",
      factoryState: "awaiting_queue",
      agentSessionId: "session-20",
      prNumber: 17,
      prUrl: "https://github.com/krasnoperov/ballony-i-nasosy/pull/17",
      prReviewState: "approved",
      prCheckStatus: "success",
    });

    const sessionUpdates: Array<Record<string, unknown>> = [];
    const commentUpdates: Array<Record<string, unknown>> = [];
    const linear: Partial<LinearClient> = {
      updateAgentSession: async (params) => {
        sessionUpdates.push(params as unknown as Record<string, unknown>);
        return { id: params.agentSessionId };
      },
      upsertIssueComment: async (params) => {
        commentUpdates.push(params as unknown as Record<string, unknown>);
        return { id: "comment-20", body: params.body };
      },
      createAgentActivity: async () => ({ id: "activity-20" }),
      getIssue: async () => { throw new Error("not used"); },
      setIssueState: async () => { throw new Error("not used"); },
      updateIssueLabels: async () => { throw new Error("not used"); },
      getActorProfile: async () => ({ actorId: "patchrelay-actor" }),
      getWorkspaceCatalog: async () => ({ workspace: {}, teams: [], projects: [] }),
    };

    const sync = new LinearSessionSync(
      config,
      db,
      { forProject: async () => linear as LinearClient },
      pino({ enabled: false }),
    );

    await sync.syncSession(db.getIssue(issue.projectId, issue.linearIssueId)!);

    assert.equal(sessionUpdates.length, 1);
    assert.equal(commentUpdates.length, 0);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("syncSession keeps a final visible comment for done planning-only issues", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-linear-sync-planning-done-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "krasnoperov/ballony-i-nasosy",
      linearIssueId: "issue-tst-21",
      issueKey: "TST-21",
      title: "Re-measure CI after the speedup wave and decide whether artifact handoff is still worth it",
      factoryState: "done",
      agentSessionId: "session-21",
      currentLinearState: "Done",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.runs.finishRun(run.id, { status: "completed" });

    const commentUpdates: Array<Record<string, unknown>> = [];
    const linear: Partial<LinearClient> = {
      updateAgentSession: async (params) => ({ id: params.agentSessionId }),
      upsertIssueComment: async (params) => {
        commentUpdates.push(params as unknown as Record<string, unknown>);
        return { id: "comment-21", body: params.body };
      },
      createAgentActivity: async () => ({ id: "activity-21" }),
      getIssue: async () => { throw new Error("not used"); },
      setIssueState: async () => { throw new Error("not used"); },
      updateIssueLabels: async () => { throw new Error("not used"); },
      getActorProfile: async () => ({ actorId: "patchrelay-actor" }),
      getWorkspaceCatalog: async () => ({ workspace: {}, teams: [], projects: [] }),
    };

    const sync = new LinearSessionSync(
      config,
      db,
      { forProject: async () => linear as LinearClient },
      pino({ enabled: false }),
    );

    await sync.syncSession(db.getIssue(issue.projectId, issue.linearIssueId)!);

    assert.equal(commentUpdates.length, 1);
    assert.match(String(commentUpdates[0]?.body), /Completed/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("syncSession moves backlog issues into an active started state when implementation starts", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-linear-sync-active-state-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "krasnoperov/ballony-i-nasosy",
      linearIssueId: "issue-tst-30",
      issueKey: "TST-30",
      title: "Start implementation",
      factoryState: "implementing",
      currentLinearState: "Backlog",
      currentLinearStateType: "backlog",
      agentSessionId: "session-30",
      activeRunId: 1,
    });

    const setIssueStateCalls: string[] = [];
    const linear: Partial<LinearClient> = {
      updateAgentSession: async (params) => ({ id: params.agentSessionId }),
      upsertIssueComment: async (params) => ({ id: "comment-30", body: params.body }),
      createAgentActivity: async () => ({ id: "activity-30" }),
      getIssue: async () => ({
        id: issue.linearIssueId,
        identifier: issue.issueKey,
        title: issue.title,
        delegateId: "patchrelay-actor",
        stateName: "Backlog",
        stateType: "backlog",
        workflowStates: [
          { id: "state-backlog", name: "Backlog", type: "backlog" },
          { id: "state-progress", name: "In Progress", type: "started" },
          { id: "state-review", name: "In Review", type: "started" },
          { id: "state-done", name: "Done", type: "completed" },
        ],
        blockedBy: [],
        relationsKnown: true,
      }),
      setIssueState: async (_issueId, stateName) => {
        setIssueStateCalls.push(stateName);
        return {
          id: issue.linearIssueId,
          identifier: issue.issueKey,
          title: issue.title,
          delegateId: "patchrelay-actor",
          stateName,
          stateType: stateName === "Done" ? "completed" : "started",
          workflowStates: [
            { id: "state-backlog", name: "Backlog", type: "backlog" },
            { id: "state-progress", name: "In Progress", type: "started" },
            { id: "state-review", name: "In Review", type: "started" },
            { id: "state-done", name: "Done", type: "completed" },
          ],
          blockedBy: [],
          relationsKnown: true,
        };
      },
      updateIssueLabels: async () => { throw new Error("not used"); },
      getActorProfile: async () => ({ actorId: "patchrelay-actor" }),
      getWorkspaceCatalog: async () => ({ workspace: {}, teams: [], projects: [] }),
    };

    const sync = new LinearSessionSync(
      config,
      db,
      { forProject: async () => linear as LinearClient },
      pino({ enabled: false }),
    );

    await sync.syncSession(db.getIssue(issue.projectId, issue.linearIssueId)!, { activeRunType: "implementation" });

    assert.deepEqual(setIssueStateCalls, ["In Progress"]);
    assert.equal(db.getIssue(issue.projectId, issue.linearIssueId)?.currentLinearState, "In Progress");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("syncSession moves backlog issues into review when a PR is opened or waiting downstream", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-linear-sync-review-state-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "krasnoperov/ballony-i-nasosy",
      linearIssueId: "issue-tst-31",
      issueKey: "TST-31",
      title: "Waiting downstream",
      factoryState: "awaiting_queue",
      currentLinearState: "Backlog",
      currentLinearStateType: "backlog",
      agentSessionId: "session-31",
      prNumber: 31,
      prUrl: "https://github.com/krasnoperov/ballony-i-nasosy/pull/31",
      prReviewState: "approved",
      prCheckStatus: "success",
    });

    const setIssueStateCalls: string[] = [];
    const linear: Partial<LinearClient> = {
      updateAgentSession: async (params) => ({ id: params.agentSessionId }),
      upsertIssueComment: async (params) => ({ id: "comment-31", body: params.body }),
      createAgentActivity: async () => ({ id: "activity-31" }),
      getIssue: async () => ({
        id: issue.linearIssueId,
        identifier: issue.issueKey,
        title: issue.title,
        delegateId: "patchrelay-actor",
        stateName: "Backlog",
        stateType: "backlog",
        workflowStates: [
          { id: "state-backlog", name: "Backlog", type: "backlog" },
          { id: "state-progress", name: "In Progress", type: "started" },
          { id: "state-review", name: "In Review", type: "started" },
          { id: "state-done", name: "Done", type: "completed" },
        ],
        blockedBy: [],
        relationsKnown: true,
      }),
      setIssueState: async (_issueId, stateName) => {
        setIssueStateCalls.push(stateName);
        return {
          id: issue.linearIssueId,
          identifier: issue.issueKey,
          title: issue.title,
          delegateId: "patchrelay-actor",
          stateName,
          stateType: stateName === "Done" ? "completed" : "started",
          workflowStates: [
            { id: "state-backlog", name: "Backlog", type: "backlog" },
            { id: "state-progress", name: "In Progress", type: "started" },
            { id: "state-review", name: "In Review", type: "started" },
            { id: "state-done", name: "Done", type: "completed" },
          ],
          blockedBy: [],
          relationsKnown: true,
        };
      },
      updateIssueLabels: async () => { throw new Error("not used"); },
      getActorProfile: async () => ({ actorId: "patchrelay-actor" }),
      getWorkspaceCatalog: async () => ({ workspace: {}, teams: [], projects: [] }),
    };

    const sync = new LinearSessionSync(
      config,
      db,
      { forProject: async () => linear as LinearClient },
      pino({ enabled: false }),
    );

    await sync.syncSession(db.getIssue(issue.projectId, issue.linearIssueId)!);

    assert.deepEqual(setIssueStateCalls, ["In Review"]);
    assert.equal(db.getIssue(issue.projectId, issue.linearIssueId)?.currentLinearState, "In Review");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("syncSession maps Usertold implementation work into Implementing instead of Deploying", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-linear-sync-usertold-implementing-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "krasnoperov/ballony-i-nasosy",
      linearIssueId: "issue-use-103",
      issueKey: "USE-103",
      title: "Fix mobile input sizing",
      factoryState: "implementing",
      currentLinearState: "Backlog",
      currentLinearStateType: "backlog",
      agentSessionId: "session-use-103",
      activeRunId: 103,
    });

    const workflowStates = [
      { id: "state-backlog", name: "Backlog", type: "backlog" },
      { id: "state-start", name: "Start", type: "unstarted" },
      { id: "state-review", name: "Review", type: "unstarted" },
      { id: "state-deploy", name: "Deploy", type: "unstarted" },
      { id: "state-human", name: "Human Needed", type: "unstarted" },
      { id: "state-deploying", name: "Deploying", type: "started" },
      { id: "state-reviewing", name: "Reviewing", type: "started" },
      { id: "state-implementing", name: "Implementing", type: "started" },
      { id: "state-done", name: "Done", type: "completed" },
    ];

    const setIssueStateCalls: string[] = [];
    const linear: Partial<LinearClient> = {
      updateAgentSession: async (params) => ({ id: params.agentSessionId }),
      upsertIssueComment: async (params) => ({ id: "comment-use-103", body: params.body }),
      createAgentActivity: async () => ({ id: "activity-use-103" }),
      getIssue: async () => ({
        id: issue.linearIssueId,
        identifier: issue.issueKey,
        title: issue.title,
        delegateId: "patchrelay-actor",
        stateName: "Backlog",
        stateType: "backlog",
        workflowStates,
        blockedBy: [],
        relationsKnown: true,
      }),
      setIssueState: async (_issueId, stateName) => {
        setIssueStateCalls.push(stateName);
        return {
          id: issue.linearIssueId,
          identifier: issue.issueKey,
          title: issue.title,
          delegateId: "patchrelay-actor",
          stateName,
          stateType: stateName === "Done" ? "completed" : "started",
          workflowStates,
          blockedBy: [],
          relationsKnown: true,
        };
      },
      updateIssueLabels: async () => { throw new Error("not used"); },
      getActorProfile: async () => ({ actorId: "patchrelay-actor" }),
      getWorkspaceCatalog: async () => ({ workspace: {}, teams: [], projects: [] }),
    };

    const sync = new LinearSessionSync(
      config,
      db,
      { forProject: async () => linear as LinearClient },
      pino({ enabled: false }),
    );

    await sync.syncSession(db.getIssue(issue.projectId, issue.linearIssueId)!, { activeRunType: "implementation" });

    assert.deepEqual(setIssueStateCalls, ["Implementing"]);
    assert.equal(db.getIssue(issue.projectId, issue.linearIssueId)?.currentLinearState, "Implementing");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("syncSession can move active lifecycle issues from Implementing to Review and Deploying", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-linear-sync-usertold-lifecycle-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const workflowStates = [
      { id: "state-backlog", name: "Backlog", type: "backlog" },
      { id: "state-start", name: "Start", type: "unstarted" },
      { id: "state-review", name: "Review", type: "unstarted" },
      { id: "state-deploy", name: "Deploy", type: "unstarted" },
      { id: "state-human", name: "Human Needed", type: "unstarted" },
      { id: "state-deploying", name: "Deploying", type: "started" },
      { id: "state-reviewing", name: "Reviewing", type: "started" },
      { id: "state-implementing", name: "Implementing", type: "started" },
      { id: "state-done", name: "Done", type: "completed" },
    ];

    const reviewIssue = db.upsertIssue({
      projectId: "krasnoperov/ballony-i-nasosy",
      linearIssueId: "issue-use-review",
      issueKey: "USE-104",
      title: "Wait for review",
      factoryState: "pr_open",
      currentLinearState: "Implementing",
      currentLinearStateType: "started",
      agentSessionId: "session-use-review",
      prNumber: 41,
      prUrl: "https://github.com/krasnoperov/ballony-i-nasosy/pull/41",
      prCheckStatus: "pending",
    });
    const deployIssue = db.upsertIssue({
      projectId: "krasnoperov/ballony-i-nasosy",
      linearIssueId: "issue-use-deploy",
      issueKey: "USE-105",
      title: "Wait for merge",
      factoryState: "awaiting_queue",
      currentLinearState: "Review",
      currentLinearStateType: "unstarted",
      agentSessionId: "session-use-deploy",
      prNumber: 42,
      prUrl: "https://github.com/krasnoperov/ballony-i-nasosy/pull/42",
      prReviewState: "approved",
      prCheckStatus: "success",
    });

    const setIssueStateCalls: string[] = [];
    const linear: Partial<LinearClient> = {
      updateAgentSession: async (params) => ({ id: params.agentSessionId }),
      upsertIssueComment: async (params) => ({ id: "comment-use-lifecycle", body: params.body }),
      createAgentActivity: async () => ({ id: "activity-use-lifecycle" }),
      getIssue: async (issueId) => {
        const stateName = issueId === reviewIssue.linearIssueId ? "Implementing" : "Review";
        const stateType = issueId === reviewIssue.linearIssueId ? "started" : "unstarted";
        const title = issueId === reviewIssue.linearIssueId ? reviewIssue.title : deployIssue.title;
        const identifier = issueId === reviewIssue.linearIssueId ? reviewIssue.issueKey : deployIssue.issueKey;
        return {
          id: issueId,
          identifier,
          title,
          delegateId: "patchrelay-actor",
          stateName,
          stateType,
          workflowStates,
          blockedBy: [],
          relationsKnown: true,
        };
      },
      setIssueState: async (issueId, stateName) => {
        setIssueStateCalls.push(`${issueId}:${stateName}`);
        return {
          id: issueId,
          identifier: issueId === reviewIssue.linearIssueId ? reviewIssue.issueKey : deployIssue.issueKey,
          title: issueId === reviewIssue.linearIssueId ? reviewIssue.title : deployIssue.title,
          delegateId: "patchrelay-actor",
          stateName,
          stateType: stateName === "Done" ? "completed" : workflowStates.find((state) => state.name === stateName)?.type ?? "started",
          workflowStates,
          blockedBy: [],
          relationsKnown: true,
        };
      },
      updateIssueLabels: async () => { throw new Error("not used"); },
      getActorProfile: async () => ({ actorId: "patchrelay-actor" }),
      getWorkspaceCatalog: async () => ({ workspace: {}, teams: [], projects: [] }),
    };

    const sync = new LinearSessionSync(
      config,
      db,
      { forProject: async () => linear as LinearClient },
      pino({ enabled: false }),
    );

    await sync.syncSession(db.getIssue(reviewIssue.projectId, reviewIssue.linearIssueId)!);
    await sync.syncSession(db.getIssue(deployIssue.projectId, deployIssue.linearIssueId)!);

    assert.deepEqual(setIssueStateCalls, [
      "issue-use-review:Review",
      "issue-use-deploy:Deploying",
    ]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("syncSession maps a pending review-quill verdict to Reviewing", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-linear-sync-usertold-reviewing-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const workflowStates = [
      { id: "state-backlog", name: "Backlog", type: "backlog" },
      { id: "state-start", name: "Start", type: "unstarted" },
      { id: "state-review", name: "Review", type: "unstarted" },
      { id: "state-deploy", name: "Deploy", type: "unstarted" },
      { id: "state-human", name: "Human Needed", type: "unstarted" },
      { id: "state-deploying", name: "Deploying", type: "started" },
      { id: "state-reviewing", name: "Reviewing", type: "started" },
      { id: "state-implementing", name: "Implementing", type: "started" },
      { id: "state-done", name: "Done", type: "completed" },
    ];

    const issue = db.upsertIssue({
      projectId: "krasnoperov/ballony-i-nasosy",
      linearIssueId: "issue-use-reviewing",
      issueKey: "USE-108",
      title: "Review Quill is working",
      factoryState: "pr_open",
      currentLinearState: "Review",
      currentLinearStateType: "unstarted",
      agentSessionId: "session-use-reviewing",
      prNumber: 108,
      prUrl: "https://github.com/krasnoperov/ballony-i-nasosy/pull/108",
      prCheckStatus: "pending",
      lastGitHubCiSnapshotJson: JSON.stringify({
        checks: [
          { name: "verify", status: "success" },
          { name: "review-quill/verdict", status: "pending" },
        ],
      }),
    });

    const setIssueStateCalls: string[] = [];
    const linear: Partial<LinearClient> = {
      updateAgentSession: async (params) => ({ id: params.agentSessionId }),
      upsertIssueComment: async (params) => ({ id: "comment-use-reviewing", body: params.body }),
      createAgentActivity: async () => ({ id: "activity-use-reviewing" }),
      getIssue: async () => ({
        id: issue.linearIssueId,
        identifier: issue.issueKey,
        title: issue.title,
        delegateId: "patchrelay-actor",
        stateName: "Review",
        stateType: "unstarted",
        workflowStates,
        blockedBy: [],
        relationsKnown: true,
      }),
      setIssueState: async (_issueId, stateName) => {
        setIssueStateCalls.push(stateName);
        return {
          id: issue.linearIssueId,
          identifier: issue.issueKey,
          title: issue.title,
          delegateId: "patchrelay-actor",
          stateName,
          stateType: workflowStates.find((state) => state.name === stateName)?.type ?? "started",
          workflowStates,
          blockedBy: [],
          relationsKnown: true,
        };
      },
      updateIssueLabels: async () => { throw new Error("not used"); },
      getActorProfile: async () => ({ actorId: "patchrelay-actor" }),
      getWorkspaceCatalog: async () => ({ workspace: {}, teams: [], projects: [] }),
    };

    const sync = new LinearSessionSync(
      config,
      db,
      { forProject: async () => linear as LinearClient },
      pino({ enabled: false }),
    );

    await sync.syncSession(db.getIssue(issue.projectId, issue.linearIssueId)!);

    assert.deepEqual(setIssueStateCalls, ["Reviewing"]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("maybeEmitProgress publishes a working summary and strips shell wrappers from commands", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-linear-sync-progress-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "krasnoperov/ballony-i-nasosy",
      linearIssueId: "issue-use-progress",
      issueKey: "USE-106",
      title: "Improve progress reporting",
      factoryState: "implementing",
      agentSessionId: "session-use-progress",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });

    const activities: Array<Record<string, unknown>> = [];
    const linear: Partial<LinearClient> = {
      updateAgentSession: async (params) => ({ id: params.agentSessionId }),
      upsertIssueComment: async (params) => ({ id: "comment-use-progress", body: params.body }),
      createAgentActivity: async (params) => {
        activities.push(params as unknown as Record<string, unknown>);
        return { id: `activity-${activities.length}` };
      },
      getIssue: async () => { throw new Error("not used"); },
      setIssueState: async () => { throw new Error("not used"); },
      updateIssueLabels: async () => { throw new Error("not used"); },
      getActorProfile: async () => ({ actorId: "patchrelay-actor" }),
      getWorkspaceCatalog: async () => ({ workspace: {}, teams: [], projects: [] }),
    };

    const sync = new LinearSessionSync(
      config,
      db,
      { forProject: async () => linear as LinearClient },
      pino({ enabled: false }),
    );

    sync.maybeEmitProgress({
      method: "turn/plan/updated",
      params: { plan: [{ step: "Audit the mobile Study form controls", status: "inProgress" }] },
    }, run);
    sync.maybeEmitProgress({
      method: "item/started",
      params: { item: { type: "commandExecution", command: "/bin/bash -lc 'npm run check'" } },
    }, run);

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(activities.length, 2);
    assert.deepEqual(activities[0]?.content, {
      type: "response",
      body: "Working on: Audit the mobile Study form controls.",
    });
    assert.equal(activities[0]?.ephemeral, undefined);
    assert.deepEqual(activities[1]?.content, {
      type: "action",
      action: "Running",
      parameter: "npm run check",
    });
    assert.equal(activities[1]?.ephemeral, true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("maybeEmitProgress publishes the first sentence from each agent message as an ephemeral thought", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-linear-sync-agent-message-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "krasnoperov/ballony-i-nasosy",
      linearIssueId: "issue-use-message",
      issueKey: "USE-107",
      title: "Emit agent message progress",
      factoryState: "implementing",
      agentSessionId: "session-use-message",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });

    const activities: Array<Record<string, unknown>> = [];
    const linear: Partial<LinearClient> = {
      updateAgentSession: async (params) => ({ id: params.agentSessionId }),
      upsertIssueComment: async (params) => ({ id: "comment-use-message", body: params.body }),
      createAgentActivity: async (params) => {
        activities.push(params as unknown as Record<string, unknown>);
        return { id: `activity-${activities.length}` };
      },
      getIssue: async () => { throw new Error("not used"); },
      setIssueState: async () => { throw new Error("not used"); },
      updateIssueLabels: async () => { throw new Error("not used"); },
      getActorProfile: async () => ({ actorId: "patchrelay-actor" }),
      getWorkspaceCatalog: async () => ({ workspace: {}, teams: [], projects: [] }),
    };

    const sync = new LinearSessionSync(
      config,
      db,
      { forProject: async () => linear as LinearClient },
      pino({ enabled: false }),
    );

    sync.maybeEmitProgress({
      method: "item/agentMessage/delta",
      params: { itemId: "msg-1", delta: "Checking the shared Study field styles. Then I will compare other forms." },
    }, run);

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(activities.length, 2);
    assert.deepEqual(activities[0]?.content, {
      type: "response",
      body: "Working on: Checking the shared Study field styles.",
    });
    assert.deepEqual(activities[1]?.content, {
      type: "thought",
      body: "Checking the shared Study field styles.",
    });
    assert.equal(activities[1]?.ephemeral, true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("maybeEmitProgress waits for a complete sentence before publishing streamed agent progress", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-linear-sync-agent-message-complete-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "krasnoperov/ballony-i-nasosy",
      linearIssueId: "issue-use-message-complete",
      issueKey: "USE-109",
      title: "Wait for full streamed sentence",
      factoryState: "implementing",
      agentSessionId: "session-use-message-complete",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });

    const activities: Array<Record<string, unknown>> = [];
    const linear: Partial<LinearClient> = {
      updateAgentSession: async (params) => ({ id: params.agentSessionId }),
      upsertIssueComment: async (params) => ({ id: "comment-use-message-complete", body: params.body }),
      createAgentActivity: async (params) => {
        activities.push(params as unknown as Record<string, unknown>);
        return { id: `activity-${activities.length}` };
      },
      getIssue: async () => { throw new Error("not used"); },
      setIssueState: async () => { throw new Error("not used"); },
      updateIssueLabels: async () => { throw new Error("not used"); },
      getActorProfile: async () => ({ actorId: "patchrelay-actor" }),
      getWorkspaceCatalog: async () => ({ workspace: {}, teams: [], projects: [] }),
    };

    const sync = new LinearSessionSync(
      config,
      db,
      { forProject: async () => linear as LinearClient },
      pino({ enabled: false }),
    );

    sync.maybeEmitProgress({
      method: "item/agentMessage/delta",
      params: { itemId: "msg-2", delta: "I" },
    }, run);

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(activities.length, 0);

    sync.maybeEmitProgress({
      method: "item/agentMessage/delta",
      params: { itemId: "msg-2", delta: " am checking the shared Study field styles." },
    }, run);

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(activities.length, 2);
    assert.deepEqual(activities[0]?.content, {
      type: "response",
      body: "Working on: I am checking the shared Study field styles.",
    });
    assert.deepEqual(activities[1]?.content, {
      type: "thought",
      body: "I am checking the shared Study field styles.",
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
