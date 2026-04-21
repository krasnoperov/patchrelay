import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { MainBranchHealthMonitor } from "../src/main-branch-health-monitor.ts";
import type { LinearClient, LinearIssueSnapshot } from "../src/linear-types.ts";
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
        id: "proj",
        repoPath: path.join(baseDir, "repo"),
        worktreeRoot: path.join(baseDir, "worktrees"),
        issueKeyPrefixes: ["PRJ"],
        linearTeamIds: ["team-1"],
        allowLabels: [],
        triggerEvents: ["statusChanged"],
        branchPrefix: "prj",
        github: {
          repoFullName: "owner/repo",
          baseBranch: "main",
          priorityQueueLabel: "queue:priority",
        },
      },
    ],
    secretSources: {},
  };
}

function writeGhScript(baseDir: string): string {
  const fakeBin = path.join(baseDir, "bin");
  const ghPath = path.join(fakeBin, "gh");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "api" ] && [ "$2" = "repos/owner/repo/branches/main" ]; then
  printf 'base-sha-123'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/owner/repo/commits/base-sha-123/check-runs" ]; then
  printf '[{"name":"Tests","status":"completed","conclusion":"failure","details_url":"https://ci.example/tests"},{"name":"Deploy","status":"queued","conclusion":null}]'
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`, "utf8");
  chmodSync(ghPath, 0o755);
  return fakeBin;
}

function makeLinearIssueSnapshot(): LinearIssueSnapshot {
  return {
    id: "lin-1",
    identifier: "PRJ-77",
    title: "Repair main for owner/repo",
    description: "restore main",
    url: "https://linear.app/example/issue/PRJ-77",
    priority: 1,
    estimate: 2,
    stateName: "In Progress",
    stateType: "started",
    workflowStates: [],
    labelIds: [],
    labels: [],
    teamLabels: [],
    blockedBy: [],
    blocks: [],
  };
}

test("main branch health monitor creates a main_repair issue and wake when main is red", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-main-repair-"));
  const oldPath = process.env.PATH;
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const fakeBin = writeGhScript(baseDir);
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const createdIssues: Array<{ teamId: string; title: string; description?: string }> = [];
    const linearClient: LinearClient = {
      async getIssue() {
        throw new Error("not used");
      },
      async createIssue(params) {
        createdIssues.push(params);
        return makeLinearIssueSnapshot();
      },
      async setIssueState() {
        throw new Error("not used");
      },
      async upsertIssueComment() {
        throw new Error("not used");
      },
      async createAgentActivity() {
        throw new Error("not used");
      },
      async updateIssueLabels() {
        throw new Error("not used");
      },
      async getActorProfile() {
        throw new Error("not used");
      },
      async getWorkspaceCatalog() {
        throw new Error("not used");
      },
    };

    const enqueueCalls: Array<{ projectId: string; issueId: string }> = [];
    const monitor = new MainBranchHealthMonitor(
      db,
      config,
      { forProject: async () => linearClient },
      (projectId, issueId) => { enqueueCalls.push({ projectId, issueId }); },
      pino({ enabled: false }),
    );

    await monitor.reconcile();

    assert.equal(createdIssues.length, 1);
    assert.equal(createdIssues[0]!.teamId, "team-1");
    assert.match(createdIssues[0]!.title, /Repair main for owner\/repo/);
    assert.match(createdIssues[0]!.description ?? "", /queue:priority/);

    const issue = db.getIssue("proj", "lin-1");
    assert.equal(issue?.branchName, "main-repair/main");
    assert.equal(issue?.factoryState, "delegated");
    assert.equal(issue?.issueKey, "PRJ-77");

    const wake = db.issueSessions.peekIssueSessionWake("proj", "lin-1");
    assert.equal(wake?.runType, "main_repair");
    assert.equal(wake?.context.baseSha, "base-sha-123");
    assert.equal(wake?.context.priorityLabel, "queue:priority");
    assert.deepEqual(wake?.context.failingChecks, [{ name: "Tests", url: "https://ci.example/tests" }]);
    assert.deepEqual(wake?.context.pendingChecks, [{ name: "Deploy" }]);
    assert.deepEqual(enqueueCalls, [{ projectId: "proj", issueId: "lin-1" }]);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});
