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

test("cli cluster reports a same-head requested-changes stall", async () => {
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
              latestReviews: [
                {
                  state: "CHANGES_REQUESTED",
                  commit: { oid: "abc123" },
                },
              ],
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
    assert.match(text, /CI USE-33 PR #27 {2}gate=success {2}next=missing {2}Requested changes still block the same head and no fix run is active/);
    assert.match(text, /FAIL \[github:review-handoff USE-33 PR #27\] Requested changes still block the current head, but no review fix is running/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli cluster ignores reviewer requests when the same head is still blocked", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cluster-review-request-same-head-"));
  const config = createConfig(baseDir, 19795);
  mkdirSync(config.projects[0]!.repoPath, { recursive: true });
  mkdirSync(config.projects[0]!.worktreeRoot, { recursive: true });
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();
  const server = await startPatchRelayHealthServer(config);

  try {
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-use-36",
      issueKey: "USE-36",
      title: "Reviewer request on same blocked head",
      currentLinearState: "In Progress",
      factoryState: "pr_open",
      prNumber: 36,
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
              reviewRequests: [{ login: "review-quill[bot]" }],
              latestReviews: [
                {
                  state: "CHANGES_REQUESTED",
                  commit: { oid: "abc123" },
                },
              ],
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
    assert.match(text, /CI USE-36 PR #36 {2}gate=success {2}next=missing {2}Requested changes still block the same head and no fix run is active/);
    assert.match(text, /FAIL \[github:review-handoff USE-36 PR #36\] Requested changes still block the current head, but no review fix is running/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli cluster reports dirty requested-changes PRs as missing branch upkeep, not waiting on review", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cluster-dirty-review-upkeep-"));
  const config = createConfig(baseDir, 19796);
  mkdirSync(config.projects[0]!.repoPath, { recursive: true });
  mkdirSync(config.projects[0]!.worktreeRoot, { recursive: true });
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();
  const server = await startPatchRelayHealthServer(config);

  try {
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-use-37",
      issueKey: "USE-37",
      title: "Dirty requested-changes PR",
      currentLinearState: "In Progress",
      factoryState: "pr_open",
      prNumber: 37,
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
              latestReviews: [
                {
                  state: "CHANGES_REQUESTED",
                  commit: { oid: "abc123" },
                },
              ],
              statusCheckRollup: [
                { __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "SUCCESS" },
              ],
              mergeable: "CONFLICTING",
              mergeStateStatus: "DIRTY",
              headRefOid: "def456",
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
    assert.match(text, /CI USE-37 PR #37 {2}gate=success {2}next=missing {2}PR is still dirty after a newer pushed head and no branch-upkeep run is active/);
    assert.match(text, /FAIL \[github:branch-upkeep USE-37 PR #37\] PR is still dirty after requested changes, but no branch-upkeep run is active/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli cluster treats a live review-quill attempt on the current head as an owner", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cluster-review-quill-active-"));
  const config = createConfig(baseDir, 19794);
  mkdirSync(config.projects[0]!.repoPath, { recursive: true });
  mkdirSync(config.projects[0]!.worktreeRoot, { recursive: true });
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();
  const server = await startPatchRelayHealthServer(config);

  try {
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-use-35",
      issueKey: "USE-35",
      title: "Review quill is actively reviewing",
      currentLinearState: "In Progress",
      factoryState: "pr_open",
      prNumber: 35,
      prState: "open",
      prReviewState: "review_required",
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
        if (command === "review-quill" && args.join(" ") === "service status --json") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              unit: "review-quill.service",
              systemd: { ActiveState: "active" },
              health: { ok: true },
              watch: { runningAttempts: 1 },
            }),
            stderr: "",
          };
        }
        if (command === "review-quill" && args.join(" ") === "attempts usertold 35 --json") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              repoId: "usertold",
              repoFullName: "krasnoperov/usertold",
              prNumber: 35,
              attempts: [
                {
                  id: 77,
                  headSha: "abc123",
                  status: "running",
                  stale: false,
                },
              ],
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

    assert.equal(exitCode, 0);
    assert.equal(stderr.read(), "");
    const text = stdout.read();
    assert.match(text, /PASS \[ci\] Tracked 1 PR-backed issue and each PR has a visible next owner/);
    assert.match(text, /CI summary: prs=1 pending=0 success=1 failure=0 unknown=0 missing_owner=0/);
    assert.match(text, /CI USE-35 PR #35 {2}gate=success {2}next=review-quill {2}review-quill attempt #77 is running on the current head/);
    assert.doesNotMatch(text, /github:review-handoff USE-35/);
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
    assert.match(text, /CI USE-32 PR #29 {2}gate=pending {2}next=ci\/github {2}Waiting on external CI checks to settle/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli cluster warns when active repo work overlaps on the same files", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cluster-overlap-"));
  const config = createConfig(baseDir, 19796);
  mkdirSync(config.projects[0]!.repoPath, { recursive: true });
  mkdirSync(config.projects[0]!.worktreeRoot, { recursive: true });
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();
  const server = await startPatchRelayHealthServer(config);

  try {
    const issue50 = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-use-50",
      issueKey: "USE-50",
      title: "First overlapping change",
      currentLinearState: "In Progress",
      factoryState: "implementing",
      worktreePath: path.join(baseDir, "worktrees", "USE-50"),
      threadId: "thread-use-50",
    });
    const run50 = db.createRun({
      issueId: issue50.id,
      projectId: "usertold",
      linearIssueId: "issue-use-50",
      runType: "implementation",
      promptText: "Implement first change",
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-use-50",
      activeRunId: run50.id,
      factoryState: "implementing",
    });

    const issue51 = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-use-51",
      issueKey: "USE-51",
      title: "Second overlapping change",
      currentLinearState: "In Progress",
      factoryState: "implementing",
      worktreePath: path.join(baseDir, "worktrees", "USE-51"),
      threadId: "thread-use-51",
    });
    const run51 = db.createRun({
      issueId: issue51.id,
      projectId: "usertold",
      linearIssueId: "issue-use-51",
      runType: "implementation",
      promptText: "Implement second change",
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-use-51",
      activeRunId: run51.id,
      factoryState: "implementing",
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
        if (
          command === "git"
          && args[0] === "-C"
          && (args[1] === path.join(baseDir, "worktrees", "USE-50") || args[1] === path.join(baseDir, "worktrees", "USE-51"))
          && args.slice(2).join(" ") === "status --porcelain --untracked-files=no"
        ) {
          return {
            exitCode: 0,
            stdout: " M src/frontend/game/GameRoundPage.tsx\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr.read(), "");
    const text = stdout.read();
    assert.match(text, /WARN \[issue:overlap USE-50\] Active work overlaps with USE-51: src\/frontend\/game\/GameRoundPage\.tsx/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(baseDir, { recursive: true, force: true });
  }
});
