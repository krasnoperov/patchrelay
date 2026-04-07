import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { RunOrchestrator } from "../src/run-orchestrator.ts";
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

function createOrchestrator(baseDir: string, linearProvider?: { forProject(projectId: string): Promise<LinearClient | undefined> }) {
  const config = createConfig(baseDir);
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();
  const enqueueCalls: Array<{ projectId: string; issueId: string }> = [];
  const orchestrator = new RunOrchestrator(
    config,
    db,
    {
      startThread: async () => ({ threadId: "thread-1" }),
      steerTurn: async () => undefined,
      readThread: async () => ({ id: "thread-1", turns: [] }),
    } as never,
    (linearProvider ?? { forProject: async () => undefined }) as never,
    (projectId, issueId) => {
      enqueueCalls.push({ projectId, issueId });
    },
    pino({ enabled: false }),
  );
  return { config, db, enqueueCalls, orchestrator };
}

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("reconcileIdleIssues advances approved idle issues to awaiting_queue", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-approved-"));
  try {
    const { db, orchestrator } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-10",
      issueKey: "USE-10",
      branchName: "feat-approved",
      prNumber: 10,
      prState: "open",
      prReviewState: "approved",
      prCheckStatus: "success",
      factoryState: "pr_open",
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-10");
    assert.equal(issue?.factoryState, "awaiting_queue");
    assert.equal(issue?.branchOwner, "patchrelay");
    assert.equal(issue?.pendingRunType, undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileActiveRuns moves merged issues to a completed Linear state", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-merged-linear-state-"));
  try {
    const setIssueStateCalls: string[] = [];
    const { db, orchestrator } = createOrchestrator(baseDir, {
      forProject: async () => ({
        getIssue: async () => ({
          id: "issue-merged-linear",
          identifier: "USE-11C",
          title: "Merged issue",
          description: "",
          url: "https://linear.app/usertold/issue/USE-11C",
          teamId: "team-use",
          teamKey: "USE",
          stateId: "state-review",
          stateName: "In Progress",
          stateType: "started",
          workflowStates: [
            { id: "state-progress", name: "In Progress", type: "started" },
            { id: "state-done", name: "Done", type: "completed" },
          ],
          labelIds: [],
          labels: [],
          teamLabels: [],
          blockedBy: [],
          blocks: [],
        }),
        setIssueState: async (_issueId: string, stateName: string) => {
          setIssueStateCalls.push(stateName);
          return {
            id: "issue-merged-linear",
            identifier: "USE-11C",
            title: "Merged issue",
            description: "",
            url: "https://linear.app/usertold/issue/USE-11C",
            teamId: "team-use",
            teamKey: "USE",
            stateId: "state-done",
            stateName: "Done",
            stateType: "completed",
            workflowStates: [
              { id: "state-progress", name: "In Progress", type: "started" },
              { id: "state-done", name: "Done", type: "completed" },
            ],
            labelIds: [],
            labels: [],
            teamLabels: [],
            blockedBy: [],
            blocks: [],
          };
        },
      }) as LinearClient,
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-merged-linear",
      issueKey: "USE-11C",
      branchName: "feat-merged-linear",
      prNumber: 113,
      prState: "merged",
      prHeadSha: "sha-merged-linear",
      prAuthorLogin: "patchrelay[bot]",
      factoryState: "done",
      currentLinearState: "In Progress",
      currentLinearStateType: "started",
    });

    await orchestrator.reconcileActiveRuns();

    const issue = db.getIssue("usertold", "issue-merged-linear");
    assert.equal(issue?.currentLinearState, "Done");
    assert.equal(issue?.currentLinearStateType, "completed");
    assert.deepEqual(setIssueStateCalls, ["Done"]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("idle reconciliation refreshes stale green check status from GitHub truth", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-green-truth-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = path.join(baseDir, "bin");
    const ghPath = path.join(fakeBin, "gh");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"headRefOid":"sha-green","state":"OPEN","reviewDecision":"CHANGES_REQUESTED","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","labels":[],"statusCheckRollup":[{"__typename":"CheckRun","name":"verify","status":"COMPLETED","conclusion":"SUCCESS"}]}'
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`, "utf8");
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, orchestrator } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-green-truth",
      issueKey: "USE-11B",
      branchName: "feat-green-truth",
      prNumber: 112,
      prState: "open",
      prHeadSha: "sha-green",
      prReviewState: "changes_requested",
      prCheckStatus: "pending",
      factoryState: "pr_open",
      lastGitHubCiSnapshotHeadSha: "sha-green",
      lastGitHubCiSnapshotGateCheckName: "verify",
      lastGitHubCiSnapshotGateCheckStatus: "pending",
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-green-truth");
    assert.equal(issue?.prCheckStatus, "success");
    assert.equal(issue?.lastGitHubCiSnapshotGateCheckStatus, "success");
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("resetWorktreeToTrackedBranch clears interrupted rebase state back to the remote issue branch", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reset-worktree-"));
  try {
    const config = createConfig(baseDir);
    const remotePath = path.join(baseDir, "remote.git");
    const repoPath = config.projects[0]!.repoPath;
    const worktreePath = path.join(config.projects[0]!.worktreeRoot, "USE-RESET");
    const branchName = "use-reset";

    runGit(["init", "--bare", remotePath], baseDir);
    runGit(["clone", remotePath, repoPath], baseDir);
    runGit(["config", "user.name", "PatchRelay Test"], repoPath);
    runGit(["config", "user.email", "patchrelay@example.com"], repoPath);
    writeFileSync(path.join(repoPath, "game.txt"), "base\n", "utf8");
    runGit(["add", "game.txt"], repoPath);
    runGit(["commit", "-m", "base"], repoPath);
    runGit(["push", "-u", "origin", "HEAD:main"], repoPath);
    runGit(["checkout", "main"], repoPath);

    runGit(["worktree", "add", "-B", branchName, worktreePath, "origin/main"], repoPath);
    runGit(["config", "user.name", "PatchRelay Test"], worktreePath);
    runGit(["config", "user.email", "patchrelay@example.com"], worktreePath);
    writeFileSync(path.join(worktreePath, "game.txt"), "feature change\n", "utf8");
    runGit(["add", "game.txt"], worktreePath);
    runGit(["commit", "-m", "feature"], worktreePath);
    runGit(["push", "-u", "origin", branchName], worktreePath);

    writeFileSync(path.join(repoPath, "game.txt"), "main change\n", "utf8");
    runGit(["add", "game.txt"], repoPath);
    runGit(["commit", "-m", "main change"], repoPath);
    runGit(["push", "origin", "main"], repoPath);

    runGit(["fetch", "origin", "main"], worktreePath);
    assert.throws(() => runGit(["rebase", "origin/main"], worktreePath));
    assert.match(runGit(["status", "--short", "--branch"], worktreePath), /HEAD \(no branch\)/);
    writeFileSync(path.join(worktreePath, "game.txt"), "dirty local edit\n", "utf8");

    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const orchestrator = new RunOrchestrator(
      config,
      db,
      {
        startThread: async () => ({ threadId: "thread-1" }),
        steerTurn: async () => undefined,
        readThread: async () => ({ id: "thread-1", turns: [] }),
      } as never,
      { forProject: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    await (orchestrator as unknown as {
      resetWorktreeToTrackedBranch: (worktreePath: string, branchName: string, issue: { issueKey: string }) => Promise<void>;
    }).resetWorktreeToTrackedBranch(worktreePath, branchName, { issueKey: "USE-RESET" });

    assert.equal(runGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath), branchName);
    assert.equal(runGit(["status", "--porcelain"], worktreePath), "");
    assert.equal(runGit(["show", "HEAD:game.txt"], worktreePath), "feature change");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileIdleIssues marks merged idle issues done without enqueueing", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-merged-"));
  try {
    const { db, orchestrator } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-11",
      issueKey: "USE-11",
      branchName: "feat-merged",
      prNumber: 11,
      prState: "merged",
      factoryState: "pr_open",
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-11");
    assert.equal(issue?.factoryState, "done");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileIdleIssues currently routes failed idle issues to ci_repair", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-failed-"));
  try {
    const { db, enqueueCalls, orchestrator } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-12",
      issueKey: "USE-12",
      branchName: "feat-failed",
      prNumber: 12,
      prState: "open",
      prCheckStatus: "failed",
      factoryState: "pr_open",
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-12");
    assert.equal(issue?.factoryState, "repairing_ci");
    assert.equal(issue?.branchOwner, "patchrelay");
    assert.equal(issue?.pendingRunType, undefined);
    assert.equal(db.peekIssueSessionWake("usertold", "issue-12")?.runType, "ci_repair");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-12" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileIdleIssues treats GitHub 'failure' status as a failing check", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-failure-status-"));
  try {
    const { db, enqueueCalls, orchestrator } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-12b",
      issueKey: "USE-12B",
      branchName: "feat-failure",
      prNumber: 120,
      prState: "open",
      prCheckStatus: "failure",
      factoryState: "pr_open",
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-12b");
    assert.equal(issue?.factoryState, "repairing_ci");
    assert.equal(issue?.pendingRunType, undefined);
    assert.equal(db.peekIssueSessionWake("usertold", "issue-12b")?.runType, "ci_repair");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-12b" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileIdleIssues preserves stored steward incident context for queue repairs", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-queue-incident-"));
  try {
    const { db, enqueueCalls, orchestrator } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-13",
      issueKey: "USE-13",
      branchName: "feat-queue-failed",
      prNumber: 13,
      prState: "open",
      prCheckStatus: "failed",
      factoryState: "awaiting_queue",
      lastGitHubFailureSource: "queue_eviction",
      lastGitHubFailureCheckName: "merge-steward/queue",
      lastGitHubFailureCheckUrl: "https://github.com/owner/repo/actions/runs/13",
      lastQueueIncidentJson: JSON.stringify({
        failureReason: "queue_eviction",
        checkName: "merge-steward/queue",
        checkUrl: "https://github.com/owner/repo/actions/runs/13",
        incidentId: "incident-13",
        incidentUrl: "https://queue.example.com/queue/incidents/incident-13",
        incidentTitle: "Queue eviction: CI failure (branch-specific)",
        incidentSummary: "PR #13 was evicted from the merge queue.",
        incidentContext: {
          version: 1,
          failureClass: "branch_local",
          baseSha: "base-13",
          prHeadSha: "head-13",
          queuePosition: 2,
          baseBranch: "main",
          branch: "feat-queue-failed",
          retryHistory: [{ at: "2026-03-31T00:00:00.000Z", baseSha: "base-12", outcome: "ci_failed_retry" }],
        },
      }),
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-13");
    assert.equal(issue?.factoryState, "repairing_queue");
    assert.equal(issue?.branchOwner, "patchrelay");
    assert.equal(issue?.pendingRunType, undefined);
    assert.deepEqual(db.peekIssueSessionWake("usertold", "issue-13")?.context, {
      failureReason: "queue_eviction",
      checkName: "merge-steward/queue",
      checkUrl: "https://github.com/owner/repo/actions/runs/13",
      incidentId: "incident-13",
      incidentUrl: "https://queue.example.com/queue/incidents/incident-13",
      incidentTitle: "Queue eviction: CI failure (branch-specific)",
      incidentSummary: "PR #13 was evicted from the merge queue.",
      incidentContext: {
        version: 1,
        failureClass: "branch_local",
        baseSha: "base-13",
        prHeadSha: "head-13",
        queuePosition: 2,
        baseBranch: "main",
        branch: "feat-queue-failed",
        retryHistory: [{ at: "2026-03-31T00:00:00.000Z", baseSha: "base-12", outcome: "ci_failed_retry" }],
      },
      wakeReason: "merge_steward_incident",
    });
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-13" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileIdleIssues recovers missing queue provenance for admitted PRs with a failing merge-steward check", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-queue-provenance-"));
  const fakeBin = path.join(baseDir, "bin");
  const ghPath = path.join(fakeBin, "gh");
  const oldPath = process.env.PATH;
  try {
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "api" ] && [[ "$2" == repos/owner/repo/commits/sha-13c/check-runs ]]; then
  printf 'merge-steward/queue'
  exit 0
fi
exit 1`, "utf8");
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, enqueueCalls, orchestrator } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-13c",
      issueKey: "USE-13C",
      branchName: "feat-evicted",
      prNumber: 113,
      prState: "open",
      prHeadSha: "sha-13c",
      prCheckStatus: "failure",
      factoryState: "repairing_ci",
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-13c");
    assert.equal(issue?.factoryState, "repairing_queue");
    assert.equal(issue?.pendingRunType, undefined);
    assert.equal(db.peekIssueSessionWake("usertold", "issue-13c")?.runType, "queue_repair");
    assert.equal(issue?.lastGitHubFailureSource, "queue_eviction");
    assert.equal(issue?.lastGitHubFailureCheckName, "merge-steward/queue");
    assert.equal(issue?.lastGitHubFailureSignature, "queue_eviction::sha-13c::merge-steward/queue");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-13c" }]);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileIdleIssues does not dispatch queue repair for DIRTY PRs without queue admission", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-dirty-no-queue-"));
  const fakeBin = path.join(baseDir, "bin");
  const ghPath = path.join(fakeBin, "gh");
  const oldPath = process.env.PATH;
  try {
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"state":"OPEN","reviewDecision":"REVIEW_REQUIRED","mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","labels":[]}'
  exit 0
fi
exit 1`, "utf8");
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, enqueueCalls, orchestrator } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-13b",
      issueKey: "USE-13B",
      branchName: "feat-dirty-review",
      prNumber: 113,
      prState: "open",
      prReviewState: null,
      prCheckStatus: "success",
      factoryState: "pr_open",
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-13b");
    assert.equal(issue?.factoryState, "pr_open");
    assert.equal(issue?.pendingRunType, undefined);
    assert.deepEqual(enqueueCalls, []);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileIdleIssues dispatches queue repair for approved DIRTY PRs without queue admission", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-approved-dirty-no-queue-"));
  const fakeBin = path.join(baseDir, "bin");
  const ghPath = path.join(fakeBin, "gh");
  const oldPath = process.env.PATH;
  try {
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"state":"OPEN","reviewDecision":"APPROVED","mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","labels":[]}'
  exit 0
fi
exit 1`, "utf8");
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, enqueueCalls, orchestrator } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-13b2",
      issueKey: "USE-13B2",
      branchName: "feat-approved-dirty",
      prNumber: 113,
      prState: "open",
      prReviewState: "approved",
      prCheckStatus: "success",
      factoryState: "awaiting_queue",
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-13b2");
    assert.equal(issue?.factoryState, "repairing_queue");
    assert.equal(issue?.pendingRunType, undefined);
    assert.equal(db.peekIssueSessionWake("usertold", "issue-13b2")?.runType, "queue_repair");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-13b2" }]);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileIdleIssues recovers preemptive queue conflicts as queue repair when the PR is queue-admitted", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-preemptive-queue-conflict-"));
  const fakeBin = path.join(baseDir, "bin");
  const ghPath = path.join(fakeBin, "gh");
  const oldPath = process.env.PATH;
  try {
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "api" ] && [[ "$2" == repos/owner/repo/commits/sha-13d/check-runs ]]; then
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","labels":[{"name":"queue"}]}'
  exit 0
fi
exit 1`, "utf8");
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, enqueueCalls, orchestrator } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-13d",
      issueKey: "USE-13D",
      branchName: "feat-preemptive-conflict",
      prNumber: 113,
      prState: "open",
      prHeadSha: "sha-13d",
      prCheckStatus: "failure",
      factoryState: "awaiting_queue",
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-13d");
    assert.equal(issue?.factoryState, "repairing_queue");
    assert.equal(issue?.pendingRunType, undefined);
    assert.equal(db.peekIssueSessionWake("usertold", "issue-13d")?.runType, "queue_repair");
    assert.equal(issue?.lastGitHubFailureSource, "queue_eviction");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-13d" }]);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileIdleIssues reclassifies stale branch_ci provenance to queue repair when GitHub shows a downstream conflict", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-stale-branch-ci-"));
  const fakeBin = path.join(baseDir, "bin");
  const ghPath = path.join(fakeBin, "gh");
  const oldPath = process.env.PATH;
  try {
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "api" ] && [[ "$2" == repos/owner/repo/commits/sha-13e/check-runs ]]; then
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"mergeable":"CONFLICTING","mergeStateStatus":"DIRTY"}'
  exit 0
fi
exit 1`, "utf8");
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, enqueueCalls, orchestrator } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-13e",
      issueKey: "USE-13E",
      branchName: "feat-stale-branch-ci",
      prNumber: 113,
      prState: "open",
      prHeadSha: "sha-13e",
      prCheckStatus: "failure",
      prReviewState: "approved",
      lastGitHubFailureSource: "branch_ci",
      factoryState: "awaiting_queue",
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-13e");
    assert.equal(issue?.factoryState, "repairing_queue");
    assert.equal(issue?.pendingRunType, undefined);
    assert.equal(db.peekIssueSessionWake("usertold", "issue-13e")?.runType, "queue_repair");
    assert.equal(issue?.lastGitHubFailureSource, "queue_eviction");
    assert.equal(issue?.lastGitHubFailureCheckName, "merge-steward/queue");
    assert.equal(issue?.lastGitHubFailureSignature, "queue_eviction::sha-13e::merge-steward/queue");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-13e" }]);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileRun recovers interrupted implementation runs to pr_open when a PR already exists", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-interrupted-pr-open-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-14",
      issueKey: "USE-14",
      branchName: "feat-interrupted",
      prNumber: 14,
      prState: "open",
      prCheckStatus: "success",
      factoryState: "implementing",
    });
    const issue = db.getIssue("usertold", "issue-14");
    assert.ok(issue);
    const run = db.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "Implement USE-14",
    });
    db.updateRunThread(run.id, { threadId: "thread-14", turnId: "turn-14" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
      factoryState: "implementing",
    });

    const orchestrator = new RunOrchestrator(
      config,
      db,
      {
        startThread: async () => ({ threadId: "thread-14" }),
        steerTurn: async () => undefined,
        readThread: async () => ({
          id: "thread-14",
          turns: [{ id: "turn-14", status: "interrupted" }],
        }),
      } as never,
      { forProject: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    await (orchestrator as unknown as { reconcileRun: (run: ReturnType<typeof db.createRun>) => Promise<void> }).reconcileRun(
      db.getRun(run.id)!,
    );

    const updatedIssue = db.getIssue("usertold", "issue-14");
    const updatedRun = db.getRun(run.id);
    assert.equal(updatedIssue?.factoryState, "pr_open");
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedRun?.status, "failed");
    assert.equal(updatedRun?.failureReason, "Codex turn was interrupted");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileRun recovers interrupted implementation runs even when reconciliation sees a locally-owned lease", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-interrupted-owned-lease-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-14b",
      issueKey: "USE-14B",
      branchName: "feat-interrupted-owned",
      prNumber: 141,
      prState: "open",
      prCheckStatus: "success",
      factoryState: "implementing",
    });
    const issue = db.getIssue("usertold", "issue-14b");
    assert.ok(issue);
    const run = db.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "Implement USE-14B",
    });
    db.updateRunThread(run.id, { threadId: "thread-14b", turnId: "turn-14b" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
      factoryState: "implementing",
    });

    const orchestrator = new RunOrchestrator(
      config,
      db,
      {
        startThread: async () => ({ threadId: "thread-14b" }),
        steerTurn: async () => undefined,
        readThread: async () => ({
          id: "thread-14b",
          turns: [{ id: "turn-14b", status: "interrupted" }],
        }),
      } as never,
      { forProject: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    const leaseId = "lease-interrupted-owned";
    assert.equal(
      db.acquireIssueSessionLease({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        leaseId,
        workerId: "worker-interrupted-owned",
        leasedUntil: "2030-04-06T10:05:00.000Z",
        now: "2030-04-06T10:00:00.000Z",
      }),
      true,
    );
    ((orchestrator as unknown as { activeSessionLeases: Map<string, string> }).activeSessionLeases)
      .set(`${issue.projectId}:${issue.linearIssueId}`, leaseId);

    await (orchestrator as unknown as { reconcileRun: (run: ReturnType<typeof db.createRun>) => Promise<void> }).reconcileRun(
      db.getRun(run.id)!,
    );

    const updatedIssue = db.getIssue("usertold", "issue-14b");
    const updatedRun = db.getRun(run.id);
    const session = db.getIssueSession(issue.projectId, issue.linearIssueId);
    assert.equal(updatedIssue?.factoryState, "pr_open");
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedRun?.status, "failed");
    assert.equal(updatedRun?.failureReason, "Codex turn was interrupted");
    assert.equal(session?.leaseId, undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileRun keeps interrupted ci_repair runs in repairing_ci when the PR is still failing", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-interrupted-ci-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-15",
      issueKey: "USE-15",
      branchName: "feat-interrupted-ci",
      prNumber: 15,
      prState: "open",
      prCheckStatus: "failed",
      lastGitHubFailureSource: "branch_ci",
      factoryState: "repairing_ci",
      ciRepairAttempts: 1,
    });
    const issue = db.getIssue("usertold", "issue-15");
    assert.ok(issue);
    const run = db.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "ci_repair",
    });
    db.updateRunThread(run.id, { threadId: "thread-15", turnId: "turn-15" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });

    const orchestrator = new RunOrchestrator(
      config,
      db,
      {
        startThread: async () => ({ threadId: "thread-15" }),
        steerTurn: async () => undefined,
        readThread: async () => ({ id: "thread-15", turns: [{ id: "turn-15", status: "interrupted" }] }),
      } as never,
      { forProject: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    await (orchestrator as unknown as { reconcileRun: (run: { id: number }) => Promise<void> }).reconcileRun(db.getRun(run.id)!);

    const updatedIssue = db.getIssue("usertold", "issue-15");
    const updatedRun = db.getRun(run.id);
    assert.equal(updatedIssue?.factoryState, "repairing_ci");
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedIssue?.ciRepairAttempts, 0);
    assert.equal(updatedRun?.status, "failed");
    assert.equal(updatedRun?.failureReason, "Codex turn was interrupted");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileRun reclaims a foreign active-run lease after restart when the thread is already interrupted", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-interrupted-foreign-lease-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const enqueueCalls: Array<{ projectId: string; issueId: string }> = [];
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-15f",
      issueKey: "USE-15F",
      branchName: "feat-interrupted-foreign",
      prNumber: 151,
      prState: "open",
      prReviewState: "approved",
      prCheckStatus: "success",
      queueRepairAttempts: 1,
      factoryState: "repairing_queue",
      lastGitHubFailureSource: "queue_eviction",
      lastGitHubFailureHeadSha: "sha-15f",
      lastGitHubFailureSignature: "queue_eviction::sha-15f::merge-steward/queue",
      lastGitHubFailureCheckName: "merge-steward/queue",
      lastAttemptedFailureHeadSha: "sha-15f",
      lastAttemptedFailureSignature: "queue_eviction::sha-15f::merge-steward/queue",
    });
    const run = db.createRun({
      issueId: issue.id,
      projectId: "usertold",
      linearIssueId: "issue-15f",
      runType: "queue_repair",
      promptText: "repair queue",
    });
    db.updateRunThread(run.id, { threadId: "thread-15f", turnId: "turn-15f" });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-15f",
      activeRunId: run.id,
      factoryState: "repairing_queue",
    });
    assert.equal(
      db.acquireIssueSessionLease({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        leaseId: "foreign-lease-15f",
        workerId: "patchrelay:old-process",
        leasedUntil: "2099-04-07T01:00:00.000Z",
        now: "2099-04-07T00:50:00.000Z",
      }),
      true,
    );

    const orchestrator = new RunOrchestrator(
      config,
      db,
      {
        startThread: async () => ({ threadId: "thread-15f" }),
        steerTurn: async () => undefined,
        readThread: async () => ({
          id: "thread-15f",
          status: "notLoaded",
          preview: "",
          cwd: baseDir,
          turns: [{ id: "turn-15f", status: "interrupted", items: [] }],
        }),
      } as never,
      { forProject: async () => undefined } as never,
      (projectId, issueId) => {
        enqueueCalls.push({ projectId, issueId });
      },
      pino({ enabled: false }),
    );

    await (orchestrator as unknown as { reconcileRun: (run: typeof run) => Promise<void> }).reconcileRun(db.getRun(run.id)!);
    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const updatedIssue = db.getIssue("usertold", "issue-15f");
    const updatedRun = db.getRun(run.id);
    const session = db.getIssueSession(issue.projectId, issue.linearIssueId);
    assert.equal(updatedIssue?.factoryState, "repairing_queue");
    assert.equal(updatedIssue?.queueRepairAttempts, 0);
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedRun?.status, "failed");
    assert.equal(updatedRun?.failureReason, "Codex turn was interrupted");
    assert.equal(db.peekIssueSessionWake("usertold", "issue-15f")?.runType, "queue_repair");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-15f" }]);
    assert.equal(session?.leaseId, undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileRun leaves interrupted queue_repair eligible for retry on idle reconciliation", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-interrupted-queue-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const enqueueCalls: Array<{ projectId: string; issueId: string }> = [];
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-15q",
      issueKey: "USE-15Q",
      branchName: "feat-interrupted-queue",
      prNumber: 15,
      prState: "open",
      prReviewState: "approved",
      prCheckStatus: "success",
      queueRepairAttempts: 1,
      factoryState: "repairing_queue",
      lastGitHubFailureSource: "queue_eviction",
      lastGitHubFailureHeadSha: "sha-15q",
      lastGitHubFailureSignature: "queue_eviction::sha-15q::merge-steward/queue",
      lastGitHubFailureCheckName: "merge-steward/queue",
      lastAttemptedFailureHeadSha: "sha-15q",
      lastAttemptedFailureSignature: "queue_eviction::sha-15q::merge-steward/queue",
    });
    const run = db.createRun({
      issueId: issue.id,
      projectId: "usertold",
      linearIssueId: "issue-15q",
      runType: "queue_repair",
      promptText: "repair queue",
    });
    db.updateRunThread(run.id, { threadId: "thread-15q", turnId: "turn-15q" });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-15q",
      activeRunId: run.id,
      factoryState: "repairing_queue",
    });

    const orchestrator = new RunOrchestrator(
      config,
      db,
      {
        startThread: async () => ({ threadId: "thread-15q" }),
        steerTurn: async () => undefined,
        readThread: async () => ({ id: "thread-15q", turns: [{ id: "turn-15q", status: "interrupted" }] }),
      } as never,
      { forProject: async () => undefined } as never,
      (projectId, issueId) => {
        enqueueCalls.push({ projectId, issueId });
      },
      pino({ enabled: false }),
    );

    await (orchestrator as unknown as { reconcileRun: (run: typeof run) => Promise<void> }).reconcileRun(db.getRun(run.id)!);
    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const updatedIssue = db.getIssue("usertold", "issue-15q");
    const updatedRun = db.getRun(run.id);
    assert.equal(updatedIssue?.factoryState, "repairing_queue");
    assert.equal(updatedIssue?.queueRepairAttempts, 0);
    assert.equal(updatedIssue?.pendingRunType, undefined);
    assert.equal(db.peekIssueSessionWake("usertold", "issue-15q")?.runType, "queue_repair");
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedRun?.status, "failed");
    assert.equal(updatedRun?.failureReason, "Codex turn was interrupted");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-15q" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("completed review_fix queues follow-up upkeep when the PR is still dirty", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-review-fix-dirty-"));
  const oldPath = process.env.PATH;
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const enqueueCalls: Array<{ projectId: string; issueId: string }> = [];
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-review-dirty",
      issueKey: "USE-REVIEW-DIRTY",
      branchName: "feat-review-dirty",
      prNumber: 21,
      prState: "open",
      prReviewState: "changes_requested",
      factoryState: "changes_requested",
      reviewFixAttempts: 1,
    });
    const run = db.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
      promptText: "review fix",
    });
    db.updateRunThread(run.id, { threadId: "thread-review-dirty", turnId: "turn-review-dirty" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });

    const fakeBin = path.join(baseDir, "fake-bin");
    mkdirSync(fakeBin, { recursive: true });
    const ghPath = path.join(fakeBin, "gh");
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"headRefOid":"sha-review-dirty","state":"OPEN","reviewDecision":"CHANGES_REQUESTED","mergeStateStatus":"DIRTY"}'
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`);
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const orchestrator = new RunOrchestrator(
      config,
      db,
      {
        startThread: async () => ({ threadId: "thread-review-dirty" }),
        steerTurn: async () => undefined,
        readThread: async () => ({ id: "thread-review-dirty", turns: [{ id: "turn-review-dirty", status: "completed", items: [] }] }),
      } as never,
      { forProject: async () => undefined } as never,
      (projectId, issueId) => {
        enqueueCalls.push({ projectId, issueId });
      },
      pino({ enabled: false }),
    );

    await (orchestrator as unknown as { reconcileRun: (run: typeof run) => Promise<void> }).reconcileRun(db.getRun(run.id)!);

    const updatedIssue = db.getIssue("usertold", "issue-review-dirty");
    const wake = db.peekIssueSessionWake("usertold", "issue-review-dirty");
    const updatedRun = db.getRun(run.id);
    assert.equal(updatedRun?.status, "completed");
    assert.equal(updatedIssue?.factoryState, "changes_requested");
    assert.equal(updatedIssue?.pendingRunType, undefined);
    assert.equal(wake?.runType, "review_fix");
    assert.match(JSON.stringify(wake?.context ?? {}), /branchUpkeepRequired/);
    assert.match(JSON.stringify(wake?.context ?? {}), /GitHub still reports PR #21 as DIRTY/);
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-review-dirty" }]);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("review_fix wake infers branch upkeep context from a dirty PR", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-review-fix-wake-context-"));
  const oldPath = process.env.PATH;
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-review-wake",
      issueKey: "USE-REVIEW-WAKE",
      branchName: "feat-review-wake",
      prNumber: 31,
      prState: "open",
      prReviewState: "changes_requested",
      factoryState: "changes_requested",
      reviewFixAttempts: 3,
    });

    const fakeBin = path.join(baseDir, "fake-bin");
    mkdirSync(fakeBin, { recursive: true });
    const ghPath = path.join(fakeBin, "gh");
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"headRefOid":"sha-review-wake","state":"OPEN","reviewDecision":"CHANGES_REQUESTED","mergeStateStatus":"DIRTY"}'
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`);
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const orchestrator = new RunOrchestrator(
      config,
      db,
      {
        startThread: async () => ({ threadId: "thread-review-wake" }),
        steerTurn: async () => undefined,
        readThread: async () => ({ id: "thread-review-wake", turns: [] }),
      } as never,
      { forProject: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );
    const leaseId = "lease-review-wake";
    assert.equal(
      db.acquireIssueSessionLease({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        leaseId,
        workerId: "worker-review-wake",
        leasedUntil: "2030-04-06T10:05:00.000Z",
        now: "2030-04-06T10:00:00.000Z",
      }),
      true,
    );
    ((orchestrator as unknown as { activeSessionLeases: Map<string, string> }).activeSessionLeases)
      .set(`${issue.projectId}:${issue.linearIssueId}`, leaseId);

    const context = await (orchestrator as unknown as {
      resolveReviewFixWakeContext: (
        issue: typeof issue,
        context: Record<string, unknown> | undefined,
        project: AppConfig["projects"][number],
      ) => Promise<Record<string, unknown> | undefined>;
    }).resolveReviewFixWakeContext(issue, undefined, config.projects[0]!);

    assert.equal(context?.branchUpkeepRequired, true);
    assert.equal(context?.mergeStateStatus, "DIRTY");
    assert.match(String(context?.promptContext ?? ""), /GitHub still reports PR #31 as DIRTY/);

    const updatedIssue = db.getIssue("usertold", "issue-review-wake");
    assert.equal(updatedIssue?.prHeadSha, "sha-review-wake");
    assert.equal(updatedIssue?.prReviewState, "changes_requested");
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileIdleIssues prioritizes queue eviction recovery over approved waiting state", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-queue-eviction-priority-"));
  try {
    const { db, enqueueCalls, orchestrator } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-queue-priority",
      issueKey: "USE-QUEUE",
      branchName: "feat-queue-priority",
      prNumber: 16,
      prState: "open",
      prReviewState: "approved",
      prCheckStatus: "success",
      factoryState: "repairing_queue",
      lastGitHubFailureSource: "queue_eviction",
      lastGitHubFailureHeadSha: "sha-16",
      lastGitHubFailureSignature: "queue_eviction::sha-16::merge-steward/queue",
      lastGitHubFailureCheckName: "merge-steward/queue",
      lastAttemptedFailureHeadSha: null,
      lastAttemptedFailureSignature: null,
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-queue-priority");
    assert.equal(issue?.factoryState, "repairing_queue");
    assert.equal(issue?.pendingRunType, undefined);
    assert.equal(db.peekIssueSessionWake("usertold", "issue-queue-priority")?.runType, "queue_repair");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-queue-priority" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileRun syncs Linear session after interrupted runs when an agent session is known", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-interrupted-linear-sync-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-15b",
      issueKey: "USE-15B",
      branchName: "feat-interrupted-linear",
      prNumber: 15,
      prState: "open",
      prCheckStatus: "failed",
      lastGitHubFailureSource: "branch_ci",
      factoryState: "repairing_ci",
      ciRepairAttempts: 1,
      agentSessionId: "session-15b",
    });
    const issue = db.getIssue("usertold", "issue-15b");
    assert.ok(issue);
    const run = db.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "ci_repair",
    });
    db.updateRunThread(run.id, { threadId: "thread-15b", turnId: "turn-15b" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });

    const activities: Array<{ agentSessionId: string; body: string }> = [];
    const updates: Array<{ agentSessionId: string; planLength: number }> = [];
    const orchestrator = new RunOrchestrator(
      config,
      db,
      {
        startThread: async () => ({ threadId: "thread-15b" }),
        steerTurn: async () => undefined,
        readThread: async () => ({ id: "thread-15b", turns: [{ id: "turn-15b", status: "interrupted" }] }),
      } as never,
      {
        forProject: async () => ({
          getIssue: async () => ({
            id: "issue-15b",
            identifier: "USE-15B",
            title: "Interrupted linear sync",
            teamId: "USE",
            teamKey: "USE",
            stateId: "state-start",
            stateName: "In Progress",
            stateType: "started",
            workflowStates: [],
            labelIds: [],
            labels: [],
            teamLabels: [],
            blockedBy: [],
            blocks: [],
          }),
          createAgentActivity: async ({ agentSessionId, content }) => {
            activities.push({ agentSessionId, body: (content as { body?: string }).body ?? "" });
          },
          updateAgentSession: async ({ agentSessionId, plan }) => {
            updates.push({ agentSessionId, planLength: Array.isArray(plan) ? plan.length : 0 });
          },
        } as never),
      } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    await (orchestrator as unknown as { reconcileRun: (run: { id: number }) => Promise<void> }).reconcileRun(db.getRun(run.id)!);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(activities.length, 0);
    assert.deepEqual(updates, [{ agentSessionId: "session-15b", planLength: 4 }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("completed ci_repair does not succeed when PR head never advanced", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-head-verify-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = path.join(baseDir, "bin");
    const ghPath = path.join(fakeBin, "gh");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"headRefOid":"same-head-sha","state":"OPEN","reviewDecision":"APPROVED"}'
  exit 0
fi
exit 1
`, "utf8");
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-16",
      issueKey: "USE-16",
      branchName: "feat-no-advance",
      prNumber: 16,
      prState: "open",
      prCheckStatus: "failed",
      lastGitHubFailureSource: "branch_ci",
      lastGitHubFailureHeadSha: "same-head-sha",
      lastGitHubFailureSignature: "branch_ci::same-head-sha::Checks::Run tests",
      factoryState: "repairing_ci",
    });
    const issue = db.getIssue("usertold", "issue-16");
    assert.ok(issue);
    const run = db.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "ci_repair",
    });
    db.updateRunThread(run.id, { threadId: "thread-16", turnId: "turn-16" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });

    const orchestrator = new RunOrchestrator(
      config,
      db,
      {
        startThread: async () => ({ threadId: "thread-16" }),
        steerTurn: async () => undefined,
        readThread: async () => ({ id: "thread-16", turns: [{ id: "turn-16", status: "completed", items: [] }] }),
      } as never,
      { forProject: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    await (orchestrator as unknown as { reconcileRun: (run: { id: number }) => Promise<void> }).reconcileRun(db.getRun(run.id)!);

    const updatedIssue = db.getIssue("usertold", "issue-16");
    const updatedRun = db.getRun(run.id);
    assert.equal(updatedIssue?.factoryState, "repairing_ci");
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedRun?.status, "failed");
    assert.match(updatedRun?.failureReason ?? "", /still on failing head/);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("completed queue_repair refreshes PR head to pending checks instead of re-queuing stale ci_repair", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-queue-publish-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = path.join(baseDir, "bin");
    const ghPath = path.join(fakeBin, "gh");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"headRefOid":"sha-advanced","state":"OPEN","reviewDecision":"APPROVED"}'
  exit 0
fi
exit 1
`, "utf8");
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const orchestrator = new RunOrchestrator(
      config,
      db,
      {
        startThread: async () => ({ threadId: "thread-17" }),
        steerTurn: async () => undefined,
        readThread: async () => ({ id: "thread-17", turns: [{ id: "turn-17", status: "completed", items: [] }] }),
      } as never,
      { forProject: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-17",
      issueKey: "USE-17",
      branchName: "feat-queue-publish",
      prNumber: 17,
      prState: "open",
      prReviewState: "approved",
      prCheckStatus: "failed",
      prHeadSha: "sha-old",
      lastGitHubFailureSource: "queue_eviction",
      lastGitHubFailureHeadSha: "sha-old",
      lastGitHubFailureSignature: "queue_eviction::sha-old::merge-steward/queue",
      lastGitHubFailureCheckName: "merge-steward/queue",
      lastQueueIncidentJson: JSON.stringify({ incidentSummary: "merge conflict" }),
      factoryState: "repairing_queue",
    });
    const issue = db.getIssue("usertold", "issue-17");
    assert.ok(issue);
    const run = db.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "queue_repair",
    });
    db.updateRunThread(run.id, { threadId: "thread-17", turnId: "turn-17" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });

    await (orchestrator as unknown as { reconcileRun: (run: { id: number }) => Promise<void> }).reconcileRun(db.getRun(run.id)!);

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const updatedIssue = db.getIssue("usertold", "issue-17");
    const updatedRun = db.getRun(run.id);
    assert.equal(updatedRun?.status, "completed");
    assert.equal(updatedIssue?.factoryState, "awaiting_queue");
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedIssue?.pendingRunType, undefined);
    assert.equal(updatedIssue?.prHeadSha, "sha-advanced");
    assert.equal(updatedIssue?.prCheckStatus, "pending");
    assert.equal(updatedIssue?.lastGitHubFailureSource, undefined);
    assert.equal(updatedIssue?.lastGitHubFailureHeadSha, undefined);
    assert.equal(updatedIssue?.lastGitHubFailureSignature, undefined);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileIdleIssues leaves awaiting_queue issues idle when they are already waiting on downstream merge automation", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-awaiting-queue-"));
  try {
    const { db, orchestrator } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-15",
      issueKey: "USE-15",
      branchName: "feat-awaiting-queue",
      prNumber: 15,
      prState: "open",
      prReviewState: "approved",
      prCheckStatus: "success",
      factoryState: "awaiting_queue",
    });
    db.setBranchOwner("usertold", "issue-15", "patchrelay");
    const before = db.getIssue("usertold", "issue-15");
    assert.ok(before);

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-15");
    assert.equal(issue?.factoryState, "awaiting_queue");
    assert.equal(issue?.branchOwner, "patchrelay");
    assert.equal(issue?.pendingRunType, undefined);
    assert.equal(issue?.updatedAt, before.updatedAt);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
