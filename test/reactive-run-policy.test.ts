import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { ReactiveRunPolicy } from "../src/reactive-run-policy.ts";
import type { AppConfig } from "../src/types.ts";

function createConfig(baseDir: string): AppConfig {
  return {
    server: { bind: "127.0.0.1", port: 8787, healthPath: "/health", readinessPath: "/ready" },
    ingress: { linearWebhookPath: "/webhooks/linear", githubWebhookPath: "/webhooks/github", maxBodyBytes: 262144, maxTimestampSkewSeconds: 60 },
    logging: { level: "info", format: "logfmt", filePath: path.join(baseDir, "patchrelay.log") },
    database: { path: path.join(baseDir, "patchrelay.sqlite"), wal: true },
    linear: {
      webhookSecret: "secret",
      graphqlUrl: "https://linear.example/graphql",
      oauth: {
        clientId: "id",
        clientSecret: "secret",
        redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
        scopes: ["read", "write"],
        actor: "user",
      },
      tokenEncryptionKey: "key",
    },
    operatorApi: { enabled: false },
    runner: {
      gitBin: "git",
      codex: { bin: "node", args: ["app-server"], approvalPolicy: "never", sandboxMode: "danger-full-access", persistExtendedHistory: false },
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
        github: { repoFullName: "owner/repo" },
      },
    ],
    secretSources: {},
  };
}

function stubGh(baseDir: string, prViewJson: string): string {
  const fakeBin = path.join(baseDir, "bin");
  const ghPath = path.join(fakeBin, "gh");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s' '${prViewJson}'
  exit 0
fi
exit 1
`, "utf8");
  chmodSync(ghPath, 0o755);
  return fakeBin;
}

function setupPolicy(baseDir: string) {
  const config = createConfig(baseDir);
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();
  const lease = { projectId: "usertold", linearIssueId: "issue-1", leaseId: "lease-1" };
  db.issueSessions.forceAcquireIssueSessionLease({
    projectId: lease.projectId,
    linearIssueId: lease.linearIssueId,
    leaseId: lease.leaseId,
    workerId: "worker-1",
    leasedUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  const withHeldLease = ((projectId: string, linearIssueId: string, fn: (lease: unknown) => unknown) => fn(lease)) as never;
  const policy = new ReactiveRunPolicy(config, db, pino({ enabled: false }), withHeldLease);
  return { config, db, policy };
}

function baseIssue() {
  return {
    projectId: "usertold",
    linearIssueId: "issue-1",
    issueKey: "USE-1",
    branchName: "feat-queue",
    prNumber: 59,
    prState: "open" as const,
    prHeadSha: "sha-pr",
    prReviewState: "approved" as const,
    prCheckStatus: "failed" as const,
    factoryState: "repairing_queue" as const,
    lastGitHubFailureSource: "queue_eviction" as const,
    lastGitHubFailureHeadSha: "sha-pr",
    lastGitHubFailureSignature: "queue_eviction::sha-pr::merge-steward/queue",
    lastGitHubFailureCheckName: "merge-steward/queue",
  };
}

test("verifyReactiveRunAdvancedBranch treats queue_repair no-op as success when the PR is no longer dirty", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reactive-noop-ok-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = stubGh(baseDir, JSON.stringify({
      headRefOid: "sha-pr",
      state: "OPEN",
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    }));
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, policy } = setupPolicy(baseDir);
    const issue = db.upsertIssue(baseIssue());
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "queue_repair",
    });

    const result = await policy.verifyReactiveRunAdvancedBranch(run, issue);
    assert.equal(result, undefined);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("verifyReactiveRunAdvancedBranch still fails queue_repair when the PR remains DIRTY", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reactive-noop-dirty-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = stubGh(baseDir, JSON.stringify({
      headRefOid: "sha-pr",
      state: "OPEN",
      reviewDecision: "APPROVED",
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    }));
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, policy } = setupPolicy(baseDir);
    const issue = db.upsertIssue(baseIssue());
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "queue_repair",
    });

    const result = await policy.verifyReactiveRunAdvancedBranch(run, issue);
    assert.ok(result && result.includes("still on failing head"));
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("verifyReactiveRunAdvancedBranch keeps failing ci_repair when head did not advance", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reactive-noop-ci-"));
  const oldPath = process.env.PATH;
  try {
    // mergeStateStatus=CLEAN should NOT rescue ci_repair: the agent was supposed to fix CI and push.
    const fakeBin = stubGh(baseDir, JSON.stringify({
      headRefOid: "sha-pr",
      state: "OPEN",
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    }));
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, policy } = setupPolicy(baseDir);
    const issue = db.upsertIssue({ ...baseIssue(), factoryState: "repairing_ci", lastGitHubFailureSource: "branch_ci" });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "ci_repair",
    });

    const result = await policy.verifyReactiveRunAdvancedBranch(run, issue);
    assert.ok(result && result.includes("still on failing head"));
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});
