import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { GitHubWebhookHandler } from "../src/github-webhook-handler.ts";
import type { GitHubCiSnapshotResolver, GitHubFailureContextResolver } from "../src/github-failure-context.ts";
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
        reviewChecks: [],
        gateChecks: ["Tests"],
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

function createHandler(
  baseDir: string,
  failureContextResolver?: GitHubFailureContextResolver,
  ciSnapshotResolver?: GitHubCiSnapshotResolver,
) {
  const config = createConfig(baseDir);
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();
  const handler = new GitHubWebhookHandler(
    config,
    db,
    { forProject: async () => undefined } as never,
    () => undefined,
    pino({ enabled: false }),
    { steerTurn: async () => undefined } as never,
    undefined,
    failureContextResolver,
    ciSnapshotResolver,
  );
  return { db, handler };
}

function installGhStub(baseDir: string): { restore: () => void; readLog: () => string } {
  const previousPath = process.env.PATH;
  const logPath = path.join(baseDir, "gh.log");
  const ghPath = path.join(baseDir, "gh");
  writeFileSync(logPath, "", "utf8");
  writeFileSync(ghPath, `#!/usr/bin/env node
const fs = require("node:fs");
const logPath = process.env.GH_STUB_LOG;
fs.appendFileSync(logPath, process.argv.slice(2).join(" ") + "\\n", "utf8");
process.stdout.write("[]");
`, "utf8");
  chmodSync(ghPath, 0o755);
  process.env.PATH = `${baseDir}${path.delimiter}${previousPath ?? ""}`;
  process.env.GH_STUB_LOG = logPath;
  return {
    restore: () => {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      delete process.env.GH_STUB_LOG;
    },
    readLog: () => readFileSync(logPath, "utf8"),
  };
}

function buildCheckRunPayload(params: {
  branch: string;
  headSha: string;
  prNumber: number;
  checkName: string;
  conclusion: "success" | "failure";
}): string {
  return JSON.stringify({
    action: "completed",
    repository: { full_name: "owner/repo" },
    check_run: {
      conclusion: params.conclusion,
      name: params.checkName,
      html_url: `https://github.com/owner/repo/actions/runs/${params.prNumber}`,
      details_url: `https://github.com/owner/repo/actions/runs/${params.prNumber}`,
      head_sha: params.headSha,
      check_suite: {
        head_branch: params.branch,
        pull_requests: [
          {
            number: params.prNumber,
            head: { ref: params.branch },
          },
        ],
      },
    },
  });
}

function buildPullRequestPayload(params: {
  action: "opened" | "reopened" | "synchronize" | "closed";
  branch: string;
  headSha: string;
  prNumber: number;
  merged?: boolean;
}): string {
  return JSON.stringify({
    action: params.action,
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: params.prNumber,
      html_url: `https://github.com/owner/repo/pull/${params.prNumber}`,
      merged: params.merged ?? false,
      head: {
        ref: params.branch,
        sha: params.headSha,
      },
    },
  });
}

function buildReviewPayload(params: {
  branch: string;
  headSha: string;
  prNumber: number;
  state: "approved" | "changes_requested" | "commented";
}): string {
  return JSON.stringify({
    action: "submitted",
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: params.prNumber,
      html_url: `https://github.com/owner/repo/pull/${params.prNumber}`,
      head: {
        ref: params.branch,
        sha: params.headSha,
      },
    },
    review: {
      state: params.state,
      user: { login: "claude-bot" },
    },
  });
}

test("green gate check requests the needs-review label", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-review-label-"));
  const ghStub = installGhStub(baseDir);
  try {
    const { db, handler } = createHandler(
      baseDir,
      undefined,
      {
        resolve: async () => ({
          headSha: "sha-11",
          gateCheckName: "Tests",
          gateCheckStatus: "success",
          failedChecks: [],
          checks: [{ name: "Tests", status: "success", conclusion: "success" }],
          settledAt: "2026-04-04T00:00:05.000Z",
          capturedAt: "2026-04-04T00:00:05.000Z",
        }),
      },
    );
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-11",
      issueKey: "USE-11",
      branchName: "feat-review-label",
      prNumber: 11,
      prState: "open",
      factoryState: "pr_open",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildCheckRunPayload({
        branch: "feat-review-label",
        headSha: "sha-11",
        prNumber: 11,
        checkName: "Tests",
        conclusion: "success",
      }),
    });

    const log = ghStub.readLog();
    assert.match(log, /api --method POST repos\/owner\/repo\/issues\/11\/labels/);
    assert.match(log, /labels\[\]=needs-review/);
  } finally {
    ghStub.restore();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("pull_request synchronize clears a stale needs-review label", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-review-clear-sync-"));
  const ghStub = installGhStub(baseDir);
  try {
    const { db, handler } = createHandler(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-12",
      issueKey: "USE-12",
      branchName: "feat-review-clear",
      prNumber: 12,
      prState: "open",
      factoryState: "pr_open",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "pull_request",
      rawBody: buildPullRequestPayload({
        action: "synchronize",
        branch: "feat-review-clear",
        headSha: "sha-12",
        prNumber: 12,
      }),
    });

    const log = ghStub.readLog();
    assert.match(log, /api --method DELETE repos\/owner\/repo\/issues\/12\/labels\/needs-review/);
  } finally {
    ghStub.restore();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("approved review clears the needs-review label", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-review-clear-approval-"));
  const ghStub = installGhStub(baseDir);
  try {
    const { db, handler } = createHandler(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-13",
      issueKey: "USE-13",
      branchName: "feat-review-approved",
      prNumber: 13,
      prState: "open",
      factoryState: "pr_open",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "pull_request_review",
      rawBody: buildReviewPayload({
        branch: "feat-review-approved",
        headSha: "sha-13",
        prNumber: 13,
        state: "approved",
      }),
    });

    const log = ghStub.readLog();
    assert.match(log, /api --method DELETE repos\/owner\/repo\/issues\/13\/labels\/needs-review/);
  } finally {
    ghStub.restore();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("changes requested review clears the needs-review label", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-review-clear-changes-"));
  const ghStub = installGhStub(baseDir);
  try {
    const { db, handler } = createHandler(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-14",
      issueKey: "USE-14",
      branchName: "feat-review-changes",
      prNumber: 14,
      prState: "open",
      factoryState: "pr_open",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "pull_request_review",
      rawBody: buildReviewPayload({
        branch: "feat-review-changes",
        headSha: "sha-14",
        prNumber: 14,
        state: "changes_requested",
      }),
    });

    const log = ghStub.readLog();
    assert.match(log, /api --method DELETE repos\/owner\/repo\/issues\/14\/labels\/needs-review/);
  } finally {
    ghStub.restore();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("green gate check does not request needs-review when changes are already requested", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-review-skip-changes-requested-"));
  const ghStub = installGhStub(baseDir);
  try {
    const { db, handler } = createHandler(
      baseDir,
      undefined,
      {
        resolve: async () => ({
          headSha: "sha-15",
          gateCheckName: "Tests",
          gateCheckStatus: "success",
          failedChecks: [],
          checks: [{ name: "Tests", status: "success", conclusion: "success" }],
          settledAt: "2026-04-04T00:00:05.000Z",
          capturedAt: "2026-04-04T00:00:05.000Z",
        }),
      },
    );
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-15",
      issueKey: "USE-15",
      branchName: "feat-review-skip",
      prNumber: 15,
      prState: "open",
      prReviewState: "changes_requested",
      lastAttemptedFailureHeadSha: "sha-15",
      lastAttemptedFailureSignature: "review_fix:sha-15",
      factoryState: "changes_requested",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildCheckRunPayload({
        branch: "feat-review-skip",
        headSha: "sha-15",
        prNumber: 15,
        checkName: "Tests",
        conclusion: "success",
      }),
    });

    const log = ghStub.readLog();
    assert.doesNotMatch(log, /issues\/15\/labels/);
  } finally {
    ghStub.restore();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("green gate check re-requests needs-review after a review fix advances the PR head", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-review-rerequest-after-fix-"));
  const ghStub = installGhStub(baseDir);
  try {
    const { db, handler } = createHandler(
      baseDir,
      undefined,
      {
        resolve: async () => ({
          headSha: "sha-16-new",
          gateCheckName: "Tests",
          gateCheckStatus: "success",
          failedChecks: [],
          checks: [{ name: "Tests", status: "success", conclusion: "success" }],
          settledAt: "2026-04-04T00:00:05.000Z",
          capturedAt: "2026-04-04T00:00:05.000Z",
        }),
      },
    );
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-16",
      issueKey: "USE-16",
      branchName: "feat-review-rerequest",
      prNumber: 16,
      prState: "open",
      prReviewState: "changes_requested",
      lastAttemptedFailureHeadSha: "sha-16-old",
      lastAttemptedFailureSignature: "review_fix:sha-16-old",
      factoryState: "changes_requested",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildCheckRunPayload({
        branch: "feat-review-rerequest",
        headSha: "sha-16-new",
        prNumber: 16,
        checkName: "Tests",
        conclusion: "success",
      }),
    });

    const log = ghStub.readLog();
    assert.match(log, /api --method POST repos\/owner\/repo\/issues\/16\/labels/);
    assert.match(log, /labels\[\]=needs-review/);
  } finally {
    ghStub.restore();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("green gate check does not request needs-review while a review_fix is pending", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-review-skip-pending-review-fix-"));
  const ghStub = installGhStub(baseDir);
  try {
    const { db, handler } = createHandler(
      baseDir,
      undefined,
      {
        resolve: async () => ({
          headSha: "sha-17",
          gateCheckName: "Tests",
          gateCheckStatus: "success",
          failedChecks: [],
          checks: [{ name: "Tests", status: "success", conclusion: "success" }],
          settledAt: "2026-04-04T00:00:05.000Z",
          capturedAt: "2026-04-04T00:00:05.000Z",
        }),
      },
    );
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-17",
      issueKey: "USE-17",
      branchName: "feat-review-pending-fix",
      prNumber: 17,
      prState: "open",
      prReviewState: "changes_requested",
      pendingRunType: "review_fix",
      lastAttemptedFailureHeadSha: "sha-16-old",
      lastAttemptedFailureSignature: "review_fix:sha-16-old",
      factoryState: "changes_requested",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildCheckRunPayload({
        branch: "feat-review-pending-fix",
        headSha: "sha-17",
        prNumber: 17,
        checkName: "Tests",
        conclusion: "success",
      }),
    });

    const log = ghStub.readLog();
    assert.doesNotMatch(log, /issues\/17\/labels/);
  } finally {
    ghStub.restore();
    rmSync(baseDir, { recursive: true, force: true });
  }
});
