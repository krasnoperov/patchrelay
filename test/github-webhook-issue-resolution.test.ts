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
        persistExtendedHistory: false,
      },
    },
    projects: [
      {
        id: "owner/repo",
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

test("resolveGitHubWebhookIssue prefers PR, then branch, then issue key", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-issue-resolution-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
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
      repoFullName: "owner/repo",
      branchName: "different",
      prNumber: 101,
    } as NormalizedGitHubEvent);
    assert.equal(prResolved?.issue.linearIssueId, "issue-pr");
    assert.equal(prResolved?.linkedBy, "pr");

    const branchResolved = resolveGitHubWebhookIssue(db, project, {
      repoFullName: "owner/repo",
      branchName: "use/branch-match",
    } as NormalizedGitHubEvent);
    assert.equal(branchResolved?.issue.linearIssueId, "issue-branch");
    assert.equal(branchResolved?.linkedBy, "branch");

    const keyResolved = resolveGitHubWebhookIssue(db, project, {
      repoFullName: "owner/repo",
      branchName: "feature/USE-12-refactor",
      prBody: "Fixes USE-12",
    } as NormalizedGitHubEvent);
    assert.equal(keyResolved?.issue.linearIssueId, "issue-key");
    assert.equal(keyResolved?.linkedBy, "issue_key");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
