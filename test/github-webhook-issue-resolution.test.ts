import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { resolveGitHubWebhookIssue } from "../src/github-webhook-issue-resolution.ts";
import type { AppConfig, NormalizedGitHubEvent } from "../src/github-types.ts";

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
      },
    },
    projects: [
      {
        id: "owner/repo",
        repoPath: path.join(baseDir, "repo"),
        worktreeRoot: path.join(baseDir, "worktrees"),
        issueKeyPrefixes: ["USE"],
        linearTeamIds: ["USE"],
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

test("resolveGitHubWebhookIssue prefers PR, then branch, then issue key", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-issue-resolution-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.initializeSchema();
    db.upsertIssue({
      projectId: "owner/repo",
      linearIssueId: "issue-pr",
      issueKey: "USE-10",
      branchName: "use/pr-match",
      prNumber: 101,
    });
    db.upsertIssue({
      projectId: "owner/repo",
      linearIssueId: "issue-branch",
      issueKey: "USE-11",
      branchName: "use/branch-match",
    });
    db.upsertIssue({
      projectId: "owner/repo",
      linearIssueId: "issue-key",
      issueKey: "USE-12",
    });

    const project = config.projects[0];
    assert.ok(project);

    const prResolved = resolveGitHubWebhookIssue(db, project, {
      triggerEvent: "review_approved",
      repoFullName: "owner/repo",
      branchName: "different",
      headSha: "sha-pr",
      prNumber: 101,
    } as NormalizedGitHubEvent);
    assert.equal(prResolved?.issue.linearIssueId, "issue-pr");
    assert.equal(prResolved?.linkedBy, "pr");

    const branchResolved = resolveGitHubWebhookIssue(db, project, {
      triggerEvent: "check_passed",
      repoFullName: "owner/repo",
      branchName: "use/branch-match",
      headSha: "sha-branch",
    } as NormalizedGitHubEvent);
    assert.equal(branchResolved?.issue.linearIssueId, "issue-branch");
    assert.equal(branchResolved?.linkedBy, "branch");

    const keyResolved = resolveGitHubWebhookIssue(db, project, {
      triggerEvent: "pr_opened",
      repoFullName: "owner/repo",
      branchName: "feature/USE-12-refactor",
      headSha: "sha-key",
      prBody: "Fixes USE-12",
    } as NormalizedGitHubEvent);
    assert.equal(keyResolved?.issue.linearIssueId, "issue-key");
    assert.equal(keyResolved?.linkedBy, "issue_key");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("resolveGitHubWebhookIssue scopes equal PR numbers and branch names to the repository", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-issue-resolution-scope-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.initializeSchema();
    db.upsertIssue({
      projectId: "another/repo",
      linearIssueId: "other-pr",
      issueKey: "USE-10",
      branchName: "shared/branch",
      prNumber: 101,
    });
    db.upsertIssue({
      projectId: "owner/repo",
      linearIssueId: "owner-pr",
      issueKey: "USE-10",
      branchName: "owner/pr",
      prNumber: 101,
    });
    db.upsertIssue({
      projectId: "owner/repo",
      linearIssueId: "owner-branch",
      issueKey: "USE-11",
      branchName: "shared/branch",
    });

    const project = config.projects[0];
    assert.ok(project);

    const prResolved = resolveGitHubWebhookIssue(db, project, {
      triggerEvent: "review_approved",
      repoFullName: "owner/repo",
      branchName: "unrelated",
      headSha: "sha-pr",
      prNumber: 101,
    });
    assert.equal(prResolved?.issue.linearIssueId, "owner-pr");
    assert.equal(prResolved?.linkedBy, "pr");

    const branchResolved = resolveGitHubWebhookIssue(db, project, {
      triggerEvent: "check_passed",
      repoFullName: "owner/repo",
      branchName: "shared/branch",
      headSha: "sha-branch",
    });
    assert.equal(branchResolved?.issue.linearIssueId, "owner-branch");
    assert.equal(branchResolved?.linkedBy, "branch");

    const keyResolved = resolveGitHubWebhookIssue(db, project, {
      triggerEvent: "pr_opened",
      repoFullName: "owner/repo",
      branchName: "feature/USE-10",
      headSha: "sha-key",
      prNumber: 102,
      prBody: "Fixes USE-10",
    });
    assert.equal(keyResolved?.issue.linearIssueId, "owner-pr");
    assert.equal(keyResolved?.linkedBy, "issue_key");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("only pr_opened may establish PR ownership from an issue-key mention", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-issue-resolution-ownership-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.initializeSchema();
    db.upsertIssue({
      projectId: "owner/repo",
      linearIssueId: "owned-issue",
      issueKey: "USE-12",
      branchName: "use/owned-pr",
      prNumber: 194,
    });
    db.upsertIssue({
      projectId: "owner/repo",
      linearIssueId: "unlinked-issue",
      issueKey: "USE-13",
    });

    const project = config.projects[0];
    assert.ok(project);

    for (const triggerEvent of [
      "pr_merged",
      "pr_closed",
      "pr_synchronize",
      "review_approved",
      "review_changes_requested",
      "check_passed",
      "check_failed",
    ] as const) {
      const resolved = resolveGitHubWebhookIssue(db, project, {
        triggerEvent,
        repoFullName: "owner/repo",
        branchName: "foreign/branch",
        headSha: "foreign-sha",
        prNumber: 192,
        prBody: "Related: USE-12 and implementation notes",
      });
      assert.equal(resolved, undefined, `${triggerEvent} must not claim an issue by mention`);
    }

    const terminalForUnlinkedIssue = resolveGitHubWebhookIssue(db, project, {
      triggerEvent: "pr_merged",
      repoFullName: "owner/repo",
      branchName: "foreign/unlinked",
      headSha: "foreign-unlinked-sha",
      prNumber: 193,
      prBody: "Fixes USE-13",
    });
    assert.equal(terminalForUnlinkedIssue, undefined);

    const opened = resolveGitHubWebhookIssue(db, project, {
      triggerEvent: "pr_opened",
      repoFullName: "owner/repo",
      branchName: "feature/USE-13",
      headSha: "new-sha",
      prNumber: 195,
      prBody: "Fixes USE-13",
    });
    assert.equal(opened?.issue.linearIssueId, "unlinked-issue");
    assert.equal(opened?.linkedBy, "issue_key");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
