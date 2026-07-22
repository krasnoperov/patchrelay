import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { runTerminalWorktreeCleanup } from "../src/worktree-cleanup.ts";
import type { AppConfig } from "../src/types.ts";

function createConfig(baseDir: string): AppConfig {
  const repoPath = path.join(baseDir, "repo");
  const worktreeRoot = path.join(baseDir, "worktrees");
  return {
    server: { bind: "127.0.0.1", port: 8787, healthPath: "/health", readinessPath: "/ready" },
    ingress: {
      linearWebhookPath: "/webhooks/linear",
      githubWebhookPath: "/webhooks/github",
      maxBodyBytes: 262144,
      maxTimestampSkewSeconds: 60,
    },
    logging: { level: "info", format: "logfmt", filePath: path.join(baseDir, "patchrelay.log") },
    database: {
      path: path.join(baseDir, "patchrelay.sqlite"),
      wal: false,
      eventRetentionDays: 7,
      archiveOldEvents: false,
      archivePath: path.join(baseDir, "archive"),
    },
    maintenance: {
      worktreeRetentionHours: 24,
      worktreeCleanupIntervalMinutes: 1440,
    },
    linear: {
      webhookSecret: "secret",
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
    operatorApi: { enabled: false },
    runner: {
      gitBin: "git",
      codex: {
        bin: "codex",
        args: ["app-server"],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        persistExtendedHistory: false,
      },
    },
    repos: { root: path.join(baseDir, "repos") },
    repositories: [],
    projects: [{
      id: "proj",
      repoPath,
      worktreeRoot,
      issueKeyPrefixes: ["INV"],
      linearTeamIds: ["team"],
      linearProjectIds: [],
      allowLabels: [],
      reviewChecks: [],
      gateChecks: [],
      triggerEvents: [],
      branchPrefix: "patchrelay",
      repairBudgets: { ciRepair: 2, queueRepair: 2, reviewFix: 2 },
    }],
    secretSources: {},
  };
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function createCleanGitDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(["init"], dir);
  git(["config", "user.email", "patchrelay@example.test"], dir);
  git(["config", "user.name", "PatchRelay Test"], dir);
  writeFileSync(path.join(dir, "tracked.txt"), "clean\n");
  git(["add", "tracked.txt"], dir);
  git(["commit", "-m", "initial"], dir);
}

function addIssue(db: PatchRelayDatabase, params: {
  issueKey: string;
  worktreePath: string;
  workflowOutcome: "completed" | "failed" | "escalated";
  updatedAt: string;
  activeRunId?: number | undefined;
}): void {
  db.upsertIssue({
    projectId: "proj",
    linearIssueId: params.issueKey.toLowerCase(),
    issueKey: params.issueKey,
    workflowOutcome: params.workflowOutcome,
    worktreePath: params.worktreePath,
    ...(params.activeRunId !== undefined ? { activeRunId: params.activeRunId } : {}),
  });
  db.unsafeRawConnectionForTests()
    .prepare("UPDATE issues SET updated_at = ? WHERE project_id = ? AND linear_issue_id = ?")
    .run(params.updatedAt, "proj", params.issueKey.toLowerCase());
}

test("terminal worktree cleanup removes old clean managed worktrees only", async () => {
  const isolatedDir = mkdtempSync(path.join(tmpdir(), "patchrelay-worktree-cleanup-"));
  try {
    const config = createConfig(isolatedDir);
    mkdirSync(config.projects[0]!.repoPath, { recursive: true });
    git(["init"], config.projects[0]!.repoPath);
    mkdirSync(config.projects[0]!.worktreeRoot, { recursive: true });
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const old = "2026-06-14T12:00:00.000Z";
    const recent = "2026-06-16T11:30:00.000Z";
    const cleanOld = path.join(config.projects[0]!.worktreeRoot, "clean-old");
    const dirtyOld = path.join(config.projects[0]!.worktreeRoot, "dirty-old");
    const activeOld = path.join(config.projects[0]!.worktreeRoot, "active-old");
    const recentDone = path.join(config.projects[0]!.worktreeRoot, "recent-done");
    const delegatedOld = path.join(config.projects[0]!.worktreeRoot, "delegated-old");
    const outsideRoot = path.join(isolatedDir, "outside", "terminal");
    for (const dir of [cleanOld, dirtyOld, activeOld, recentDone, delegatedOld, outsideRoot]) {
      createCleanGitDirectory(dir);
    }
    writeFileSync(path.join(dirtyOld, "tracked.txt"), "dirty\n");

    addIssue(db, { issueKey: "INV-1", worktreePath: cleanOld, workflowOutcome: "completed", updatedAt: old });
    addIssue(db, { issueKey: "INV-2", worktreePath: dirtyOld, workflowOutcome: "failed", updatedAt: old });
    addIssue(db, { issueKey: "INV-3", worktreePath: activeOld, workflowOutcome: "completed", updatedAt: old, activeRunId: 42 });
    addIssue(db, { issueKey: "INV-4", worktreePath: recentDone, workflowOutcome: "completed", updatedAt: recent });
    addIssue(db, { issueKey: "INV-5", worktreePath: delegatedOld, workflowOutcome: undefined, updatedAt: old });
    addIssue(db, { issueKey: "INV-6", worktreePath: outsideRoot, workflowOutcome: "escalated", updatedAt: old });

    const result = await runTerminalWorktreeCleanup({
      db,
      config,
      options: { now: new Date("2026-06-16T12:00:00.000Z"), retentionHours: 24 },
    });

    assert.equal(result.deleted, 1);
    assert.equal(result.skippedDirty, 1);
    assert.equal(result.skippedActive, 1);
    assert.equal(result.skippedRecent, 1);
    assert.equal(result.skippedState, 1);
    assert.equal(result.skippedOutsideRoot, 1);
    assert.equal(result.failed, 0);
    assert.equal(existsSync(cleanOld), false);
    assert.equal(existsSync(dirtyOld), true);
    assert.equal(existsSync(activeOld), true);
    assert.equal(existsSync(recentDone), true);
    assert.equal(existsSync(delegatedOld), true);
    assert.equal(existsSync(outsideRoot), true);
    db.close();
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
  }
});
