import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli/index.ts";
import { PatchRelayDatabase } from "../src/db.ts";
import type { AppConfig } from "../src/types.ts";

function createConfig(baseDir: string, port: number): AppConfig {
  return {
    server: {
      bind: "127.0.0.1",
      port,
      publicBaseUrl: "https://patchrelay.example.com",
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
      webhookSecret: "",
      graphqlUrl: "https://linear.example/graphql",
      oauth: {
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
        scopes: ["read", "write"],
        actor: "app",
      },
      tokenEncryptionKey: "0123456789abcdef0123456789abcdef",
    },
    operatorApi: {
      enabled: false,
    },
    runner: {
      gitBin: "git",
      codex: {
        bin: "codex",
        args: ["app-server"],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        persistExtendedHistory: false,
        serviceName: "patchrelay-test",
      },
    },
    repos: {
      root: path.join(baseDir, "repos"),
    },
    repositories: [
      {
        githubRepo: "krasnoperov/usertold",
        localPath: path.join(baseDir, "repo"),
        workspace: "usertold",
        linearTeamIds: ["USE"],
        linearProjectIds: [],
        issueKeyPrefixes: ["USE"],
      },
    ],
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
          repoFullName: "krasnoperov/usertold",
        },
      },
    ],
    secretSources: {},
  };
}

function createBufferStream() {
  let buffer = "";
  return {
    stream: {
      write(chunk: string): boolean {
        buffer += chunk;
        return true;
      },
    },
    read(): string {
      return buffer;
    },
  };
}

async function startPatchRelayHealthServer(config: AppConfig): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url === config.server.healthPath) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "patchrelay", version: "0.35.17" }));
      return;
    }
    if (req.url === config.server.readinessPath) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ready: true, codexStarted: true, linearConnected: true }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => {
    server.listen(config.server.port, config.server.bind, () => resolve());
  });
  return server;
}

test("cli cluster reports unmanaged blockers and lost dispatch", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cluster-health-"));
  const config = createConfig(baseDir, 19791);
  mkdirSync(config.projects[0]!.repoPath, { recursive: true });
  mkdirSync(config.projects[0]!.worktreeRoot, { recursive: true });
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();
  const server = await startPatchRelayHealthServer(config);

  try {
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-use-31",
      issueKey: "USE-31",
      title: "Lost dispatch",
      currentLinearState: "In Progress",
      factoryState: "delegated",
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-use-34",
      issueKey: "USE-34",
      title: "Blocked downstream",
      currentLinearState: "In Progress",
      factoryState: "delegated",
    });
    db.replaceIssueDependencies({
      projectId: "usertold",
      linearIssueId: "issue-use-34",
      blockers: [
        {
          blockerLinearIssueId: "issue-use-32",
          blockerIssueKey: "USE-32",
          blockerTitle: "Missing blocker",
          blockerCurrentLinearState: "Backlog",
          blockerCurrentLinearStateType: "unstarted",
        },
      ],
    });
    const staleTime = new Date(Date.now() - 300_000).toISOString();
    db.connection.prepare("UPDATE issues SET updated_at = ?").run(staleTime);
    db.connection.prepare("UPDATE issue_sessions SET updated_at = ?").run(staleTime);

    const stdout = createBufferStream();
    const stderr = createBufferStream();
    const exitCode = await runCli(["cluster"], {
      config,
      stdout: stdout.stream,
      stderr: stderr.stream,
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    assert.equal(exitCode, 1);
    assert.equal(stderr.read(), "");
    const text = stdout.read();
    assert.match(text, /PASS \[service:patchrelay\] Healthy/);
    assert.match(text, /FAIL \[issue:dispatch USE-31\] Delegated issue is idle but no wake is queued/);
    assert.match(text, /FAIL \[issue:blockers USE-34\] Blocked by unmanaged issue USE-32/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli cluster reports stale re-review handoff with no requested reviewer", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cluster-review-"));
  const config = createConfig(baseDir, 19792);
  mkdirSync(config.projects[0]!.repoPath, { recursive: true });
  mkdirSync(config.projects[0]!.worktreeRoot, { recursive: true });
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();
  const server = await startPatchRelayHealthServer(config);

  try {
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-use-33",
      issueKey: "USE-33",
      title: "PR waiting on nobody",
      currentLinearState: "In Progress",
      factoryState: "pr_open",
      prNumber: 27,
      prState: "open",
      prReviewState: "changes_requested",
      prCheckStatus: "success",
    });
    const staleTime = new Date(Date.now() - 300_000).toISOString();
    db.connection.prepare("UPDATE issues SET updated_at = ?").run(staleTime);
    db.connection.prepare("UPDATE issue_sessions SET updated_at = ?").run(staleTime);

    const stdout = createBufferStream();
    const stderr = createBufferStream();
    const exitCode = await runCli(["cluster"], {
      config,
      stdout: stdout.stream,
      stderr: stderr.stream,
      runCommand: async (command, args) => {
        if (command === "review-quill") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              unit: "review-quill.service",
              systemd: { ActiveState: "active" },
              health: { ok: true },
              watch: { runningAttempts: 0 },
            }),
            stderr: "",
          };
        }
        if (command === "gh" && args[0] === "pr" && args[1] === "view") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              state: "OPEN",
              reviewDecision: "CHANGES_REQUESTED",
              reviewRequests: [],
              statusCheckRollup: [
                { __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "SUCCESS" },
              ],
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
              headRefOid: "abc123",
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(stderr.read(), "");
    const text = stdout.read();
    assert.match(text, /PASS \[service:review-quill\] Healthy/);
    assert.match(text, /FAIL \[ci\] 1 PR-backed issue has no visible next owner/);
    assert.match(text, /CI summary: prs=1 pending=0 success=1 failure=0 unknown=0 missing_owner=1/);
    assert.match(text, /CI USE-33 PR #27  gate=success  next=missing  No active reviewer request; re-review handoff is stale/);
    assert.match(text, /FAIL \[github:review-handoff USE-33 PR #27\] PR is waiting on re-review but no reviewer is currently requested/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli cluster treats in-progress CI as externally owned instead of orphaned", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cluster-ci-pending-"));
  const config = createConfig(baseDir, 19793);
  mkdirSync(config.projects[0]!.repoPath, { recursive: true });
  mkdirSync(config.projects[0]!.worktreeRoot, { recursive: true });
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();
  const server = await startPatchRelayHealthServer(config);

  try {
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-use-32",
      issueKey: "USE-32",
      title: "Pending CI",
      currentLinearState: "In Progress",
      factoryState: "pr_open",
      prNumber: 29,
      prState: "open",
      prReviewState: "commented",
    });
    const staleTime = new Date(Date.now() - 300_000).toISOString();
    db.connection.prepare("UPDATE issues SET updated_at = ?").run(staleTime);
    db.connection.prepare("UPDATE issue_sessions SET updated_at = ?").run(staleTime);

    const stdout = createBufferStream();
    const stderr = createBufferStream();
    const exitCode = await runCli(["cluster"], {
      config,
      stdout: stdout.stream,
      stderr: stderr.stream,
      runCommand: async (command, args) => {
        if (command === "review-quill") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              unit: "review-quill.service",
              systemd: { ActiveState: "active" },
              health: { ok: true },
              watch: { runningAttempts: 0 },
            }),
            stderr: "",
          };
        }
        if (command === "gh" && args[0] === "pr" && args[1] === "view") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              state: "OPEN",
              reviewDecision: "REVIEW_REQUIRED",
              reviewRequests: [],
              statusCheckRollup: [
                { __typename: "CheckRun", name: "Static checks", status: "COMPLETED", conclusion: "SUCCESS" },
                { __typename: "CheckRun", name: "UI smoke tests", status: "IN_PROGRESS", conclusion: "" },
              ],
              mergeable: "MERGEABLE",
              mergeStateStatus: "BLOCKED",
              headRefOid: "abc123",
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr.read(), "");
    const text = stdout.read();
    assert.match(text, /PASS \[ci\] Tracked 1 PR-backed issue and each PR has a visible next owner/);
    assert.match(text, /CI summary: prs=1 pending=1 success=0 failure=0 unknown=0 missing_owner=0/);
    assert.match(text, /CI USE-32 PR #29  gate=pending  next=ci\/github  Waiting on external CI checks to settle/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(baseDir, { recursive: true, force: true });
  }
});
