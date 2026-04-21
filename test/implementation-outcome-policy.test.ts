import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { ImplementationOutcomePolicy } from "../src/implementation-outcome-policy.ts";
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

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createDirtyRepo(baseDir: string): string {
  const repoDir = path.join(baseDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  runGit(["init", "-b", "main"], repoDir);
  runGit(["config", "user.name", "Test User"], repoDir);
  runGit(["config", "user.email", "test@example.com"], repoDir);
  writeFileSync(path.join(repoDir, "tracked.txt"), "initial\n", "utf8");
  runGit(["add", "tracked.txt"], repoDir);
  runGit(["commit", "-m", "initial"], repoDir);
  writeFileSync(path.join(repoDir, "tracked.txt"), "initial\nlocal change\n", "utf8");
  return repoDir;
}

function acquireLease(db: PatchRelayDatabase, projectId: string, linearIssueId: string) {
  const leaseId = "lease-1";
  db.issueSessions.forceAcquireIssueSessionLease({
    projectId,
    linearIssueId,
    leaseId,
    workerId: "worker-1",
    leasedUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  return { projectId, linearIssueId, leaseId };
}

function writeGhListScript(baseDir: string, output: string): string {
  const fakeBin = path.join(baseDir, "bin");
  const ghPath = path.join(fakeBin, "gh");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s' ${JSON.stringify(output)}
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`, "utf8");
  chmodSync(ghPath, 0o755);
  return fakeBin;
}

test("failed implementation recovery does not resume when GitHub already has an open PR", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-implementation-outcome-"));
  const oldPath = process.env.PATH;
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const repoDir = createDirtyRepo(baseDir);
    const fakeBin = writeGhListScript(baseDir, '[{"number":42,"url":"https://github.com/owner/repo/pull/42","state":"OPEN","author":{"login":"patchrelay"},"headRefOid":"sha-open"}]');
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-116",
      title: "Do not auto-resume published implementation work",
      branchName: "use/issue-1",
      worktreePath: repoDir,
      factoryState: "implementing",
    });
    const lease = acquireLease(db, issue.projectId, issue.linearIssueId);
    const policy = new ImplementationOutcomePolicy(
      config,
      db,
      pino({ enabled: false }),
      (_projectId, _linearIssueId, fn) => fn(lease),
    );

    const outcome = await policy.detectRecoverableFailedImplementationOutcome({
      id: 1,
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      status: "running",
      startedAt: new Date().toISOString(),
    }, issue);

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId);
    assert.equal(outcome, undefined);
    assert.equal(updatedIssue?.prNumber, 42);
    assert.equal(updatedIssue?.prState, "open");
    assert.equal(updatedIssue?.prHeadSha, "sha-open");
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});
