import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
      path: ":memory:",
      wal: false,
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

function createOrchestrator(
  baseDir: string,
  linearProvider?: { forProject(projectId: string): Promise<LinearClient | undefined> },
  codex?: {
    startThread: () => Promise<{ threadId: string }>;
    steerTurn: () => Promise<undefined>;
    readThread: (threadId: string) => Promise<{ id: string; turns: Array<{ id: string; status: string; items: Array<unknown> }> }>;
  },
) {
  const config = createConfig(baseDir);
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();
  const enqueueCalls: Array<{ projectId: string; issueId: string }> = [];
  const orchestrator = new RunOrchestrator(
    config,
    db,
    (codex ?? {
      startThread: async () => ({ threadId: "thread-1" }),
      steerTurn: async () => undefined,
      readThread: async () => ({ id: "thread-1", turns: [] }),
    }) as never,
    (linearProvider ?? { forProject: async () => undefined }) as never,
    (projectId, issueId) => {
      enqueueCalls.push({ projectId, issueId });
    },
    pino({ enabled: false }),
  );
  patchOrchestratorLeaseService(orchestrator, db);
  return { config, db, enqueueCalls, orchestrator };
}

function patchOrchestratorLeaseService(orchestrator: RunOrchestrator, db: PatchRelayDatabase): void {
  const leaseService = (orchestrator as unknown as { leaseService: {
    activeSessionLeases: Map<string, string>;
    acquire: (projectId: string, linearIssueId: string) => string | undefined;
    forceAcquire: (projectId: string, linearIssueId: string) => string | undefined;
    claimForReconciliation: (projectId: string, linearIssueId: string) => boolean | "owned" | "skip";
    heartbeat: (projectId: string, linearIssueId: string) => boolean;
    release: (projectId: string, linearIssueId: string) => void;
  } }).leaseService;
  const workerId = `patchrelay:${process.pid}`;
  const leasedUntil = () => new Date(Date.now() + 10 * 60_000).toISOString();
  const leaseKey = (projectId: string, linearIssueId: string) => `${projectId}:${linearIssueId}`;

  leaseService.acquire = (projectId, linearIssueId) => {
    const leaseId = randomUUID();
    const acquired = db.issueSessions.acquireIssueSessionLease({
      projectId,
      linearIssueId,
      leaseId,
      workerId,
      leasedUntil: leasedUntil(),
    });
    if (!acquired) return undefined;
    leaseService.activeSessionLeases.set(leaseKey(projectId, linearIssueId), leaseId);
    return leaseId;
  };

  leaseService.forceAcquire = (projectId, linearIssueId) => {
    const leaseId = randomUUID();
    const acquired = db.issueSessions.forceAcquireIssueSessionLease({
      projectId,
      linearIssueId,
      leaseId,
      workerId,
      leasedUntil: leasedUntil(),
    });
    if (!acquired) return undefined;
    leaseService.activeSessionLeases.set(leaseKey(projectId, linearIssueId), leaseId);
    return leaseId;
  };

  leaseService.claimForReconciliation = (projectId, linearIssueId) => {
    const key = leaseKey(projectId, linearIssueId);
    if (leaseService.activeSessionLeases.has(key)) return "owned";
    const session = db.issueSessions.getIssueSession(projectId, linearIssueId);
    if (!session) return "skip";
    const leasedUntilMs = session.leasedUntil ? Date.parse(session.leasedUntil) : undefined;
    if (leasedUntilMs !== undefined && Number.isFinite(leasedUntilMs) && leasedUntilMs > Date.now()) {
      return "skip";
    }
    return leaseService.acquire(projectId, linearIssueId) ? true : "skip";
  };

  leaseService.heartbeat = (projectId, linearIssueId) => {
    const key = leaseKey(projectId, linearIssueId);
    const leaseId = leaseService.activeSessionLeases.get(key) ?? db.issueSessions.getIssueSession(projectId, linearIssueId)?.leaseId;
    if (!leaseId) return false;
    const renewed = db.issueSessions.renewIssueSessionLease({
      projectId,
      linearIssueId,
      leaseId,
      leasedUntil: leasedUntil(),
    });
    if (!renewed) {
      leaseService.activeSessionLeases.delete(key);
      return false;
    }
    leaseService.activeSessionLeases.set(key, leaseId);
    return true;
  };

  leaseService.release = (projectId, linearIssueId) => {
    const key = leaseKey(projectId, linearIssueId);
    const leaseId = leaseService.activeSessionLeases.get(key);
    db.issueSessions.releaseIssueSessionLease(projectId, linearIssueId, leaseId);
    leaseService.activeSessionLeases.delete(key);
  };
}

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeGhViewScript(baseDir: string, output: string): string {
  const fakeBin = path.join(baseDir, "bin");
  const ghPath = path.join(fakeBin, "gh");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s' ${JSON.stringify(output)}
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`, "utf8");
  chmodSync(ghPath, 0o755);
  return fakeBin;
}

function summarizeRunOutcome(db: PatchRelayDatabase, issueId: string, runId: number) {
  const issue = db.getIssue("usertold", issueId);
  const run = db.runs.getRunById(runId);
  return {
    factoryState: issue?.factoryState,
    activeRunId: issue?.activeRunId,
    pendingRunType: issue?.pendingRunType,
    prState: issue?.prState,
    prHeadSha: issue?.prHeadSha,
    prReviewState: issue?.prReviewState,
    prCheckStatus: issue?.prCheckStatus,
    lastGitHubFailureSource: issue?.lastGitHubFailureSource,
    lastGitHubFailureHeadSha: issue?.lastGitHubFailureHeadSha,
    lastGitHubFailureSignature: issue?.lastGitHubFailureSignature,
    runStatus: run?.status,
    runFailureReason: run?.failureReason,
  };
}

function normalizeRunOutcomeForComparison(outcome: ReturnType<typeof summarizeRunOutcome>) {
  return {
    ...outcome,
    runFailureReason: outcome.runFailureReason?.replace(/PR #\d+/g, "PR #<n>"),
  };
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
    assert.equal(issue?.pendingRunType, undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileActiveRuns reattaches a detached running run before continuing reconciliation", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-detached-run-"));
  try {
    const { db, orchestrator } = createOrchestrator(
      baseDir,
      undefined,
      {
        startThread: async () => ({ threadId: "thread-detached" }),
        steerTurn: async () => undefined,
        readThread: async () => ({
          id: "thread-detached",
          turns: [
            {
              id: "turn-detached",
              status: "inProgress",
              items: [{ type: "agentMessage", id: "assistant-detached", text: "Still working after the completion check resume." }],
            },
          ],
        }),
      },
    );

    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-detached",
      issueKey: "USE-DETACHED",
      title: "Detached resumed run",
      factoryState: "delegated",
      threadId: "thread-detached",
      activeRunId: null,
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-detached", turnId: "turn-detached" });
    db.connection.prepare("UPDATE issue_sessions SET active_run_id = NULL, session_state = ? WHERE project_id = ? AND linear_issue_id = ?")
      .run("idle", issue.projectId, issue.linearIssueId);

    await orchestrator.reconcileActiveRuns();

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId);
    const updatedSession = db.issueSessions.getIssueSession(issue.projectId, issue.linearIssueId);
    assert.equal(updatedIssue?.activeRunId, run.id);
    assert.equal(updatedSession?.activeRunId, run.id);
    assert.equal(updatedSession?.sessionState, "running");
    assert.equal(db.runs.getRunById(run.id)?.status, "running");
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

test("idle reconciliation recovers escalated PR issues when a newer head is now pending CI", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-terminal-pending-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = path.join(baseDir, "bin");
    const ghPath = path.join(fakeBin, "gh");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"headRefOid":"sha-new","state":"OPEN","reviewDecision":"REVIEW_REQUIRED","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"__typename":"CheckRun","name":"verify","status":"IN_PROGRESS","conclusion":null}]}'
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
      linearIssueId: "issue-terminal-pending",
      issueKey: "USE-11D",
      branchName: "feat-terminal-pending",
      prNumber: 114,
      prState: "open",
      prHeadSha: "sha-old",
      prReviewState: "changes_requested",
      prCheckStatus: "success",
      factoryState: "escalated",
      lastGitHubFailureSource: "branch_ci",
      lastGitHubFailureHeadSha: "sha-old",
      lastGitHubFailureSignature: "branch_ci::sha-old::verify",
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-terminal-pending");
    assert.equal(issue?.factoryState, "pr_open");
    assert.equal(issue?.prHeadSha, "sha-new");
    assert.equal(issue?.prReviewState, "commented");
    assert.equal(issue?.prCheckStatus, "pending");
    assert.equal(issue?.lastGitHubFailureSource, undefined);
    assert.equal(issue?.lastGitHubFailureHeadSha, undefined);
    assert.equal(issue?.lastGitHubFailureSignature, undefined);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("idle reconciliation reopens terminal issues from the same green changes-requested head", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-terminal-same-head-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = path.join(baseDir, "bin");
    const ghPath = path.join(fakeBin, "gh");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"headRefOid":"sha-stuck","state":"OPEN","reviewDecision":"CHANGES_REQUESTED","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"__typename":"CheckRun","name":"verify","status":"COMPLETED","conclusion":"SUCCESS"}]}'
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
      linearIssueId: "issue-terminal-same-head",
      issueKey: "USE-11E",
      branchName: "feat-terminal-same-head",
      prNumber: 115,
      prState: "open",
      prHeadSha: "sha-stuck",
      prReviewState: "changes_requested",
      prCheckStatus: "success",
      factoryState: "escalated",
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-terminal-same-head");
    assert.equal(issue?.factoryState, "changes_requested");
    assert.equal(issue?.prHeadSha, "sha-stuck");
    assert.equal(issue?.prReviewState, "changes_requested");
    assert.equal(issue?.prCheckStatus, "success");
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-terminal-same-head")?.runType, "review_fix");
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("idle reconciliation does not reopen exhausted terminal requested-changes issues", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-terminal-same-head-exhausted-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = path.join(baseDir, "bin");
    const ghPath = path.join(fakeBin, "gh");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"headRefOid":"sha-stuck","state":"OPEN","reviewDecision":"CHANGES_REQUESTED","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"__typename":"CheckRun","name":"verify","status":"COMPLETED","conclusion":"SUCCESS"}]}'
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`, "utf8");
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, orchestrator, enqueueCalls } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-terminal-same-head-exhausted",
      issueKey: "USE-11E2",
      branchName: "feat-terminal-same-head-exhausted",
      prNumber: 115,
      prState: "open",
      prHeadSha: "sha-stuck",
      prReviewState: "changes_requested",
      prCheckStatus: "success",
      reviewFixAttempts: 10,
      factoryState: "escalated",
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-terminal-same-head-exhausted");
    assert.equal(issue?.factoryState, "escalated");
    assert.equal(issue?.prHeadSha, "sha-stuck");
    assert.equal(issue?.prReviewState, "changes_requested");
    assert.equal(issue?.prCheckStatus, "success");
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-terminal-same-head-exhausted"), undefined);
    assert.deepEqual(enqueueCalls, []);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("idle reconciliation dispatches branch upkeep when requested-changes PR is still dirty on a newer head", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-dirty-review-upkeep-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = path.join(baseDir, "bin");
    const ghPath = path.join(fakeBin, "gh");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"headRefOid":"sha-newer","state":"OPEN","reviewDecision":"CHANGES_REQUESTED","mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","statusCheckRollup":[{"__typename":"CheckRun","name":"verify","status":"COMPLETED","conclusion":"SUCCESS"}]}'
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`, "utf8");
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, orchestrator, enqueueCalls } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-dirty-review-upkeep",
      issueKey: "USE-11F",
      branchName: "feat-dirty-review-upkeep",
      prNumber: 116,
      prState: "open",
      prHeadSha: "sha-old",
      prReviewState: "changes_requested",
      prCheckStatus: "success",
      factoryState: "pr_open",
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-dirty-review-upkeep");
    const wake = db.issueSessions.peekIssueSessionWake("usertold", "issue-dirty-review-upkeep");
    assert.equal(issue?.factoryState, "changes_requested");
    assert.equal(issue?.prHeadSha, "sha-newer");
    assert.equal(issue?.prReviewState, "changes_requested");
    assert.equal(issue?.prCheckStatus, "success");
    assert.equal(wake?.runType, "branch_upkeep");
    assert.match(JSON.stringify(wake?.context ?? {}), /branchUpkeepRequired/);
    assert.match(JSON.stringify(wake?.context ?? {}), /PR #116 as DIRTY/);
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-dirty-review-upkeep" }]);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("idle reconciliation escalates non-decisive review-quill outcomes to operator input", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-neutral-review-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = path.join(baseDir, "bin");
    const ghPath = path.join(fakeBin, "gh");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"headRefOid":"sha-comment","state":"OPEN","reviewDecision":"REVIEW_REQUIRED","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"__typename":"CheckRun","name":"verify","status":"COMPLETED","conclusion":"SUCCESS"},{"__typename":"CheckRun","name":"review-quill/verdict","status":"COMPLETED","conclusion":"NEUTRAL"}]}'
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
      linearIssueId: "issue-comment-truth",
      issueKey: "USE-11C",
      branchName: "feat-comment-truth",
      prNumber: 113,
      prState: "open",
      prHeadSha: "sha-comment",
      prCheckStatus: "success",
      factoryState: "pr_open",
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-comment-truth");
    assert.equal(issue?.prReviewState, "commented");
    assert.equal(issue?.factoryState, "awaiting_input");
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

test("reconcileIdleIssues preserves done state when a completed issue's PR is closed", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-closed-done-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = path.join(baseDir, "bin");
    const ghPath = path.join(fakeBin, "gh");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"headRefOid":"sha-closed","state":"CLOSED","reviewDecision":"REVIEW_REQUIRED","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","statusCheckRollup":[]}'
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`, "utf8");
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, enqueueCalls, orchestrator } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-closed-done",
      issueKey: "USE-CLOSED",
      branchName: "feat-closed-done",
      currentLinearState: "Done",
      currentLinearStateType: "completed",
      prNumber: 193,
      prState: "open",
      prReviewState: "commented",
      prCheckStatus: "success",
      factoryState: "delegated",
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-closed-done");
    assert.equal(issue?.factoryState, "done");
    assert.equal(issue?.prState, "closed");
    assert.equal(issue?.prReviewState, undefined);
    assert.equal(issue?.prCheckStatus, undefined);
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-closed-done"), undefined);
    assert.deepEqual(enqueueCalls, []);
  } finally {
    process.env.PATH = oldPath;
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
    assert.equal(issue?.pendingRunType, undefined);
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-12")?.runType, "ci_repair");
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
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-12b")?.runType, "ci_repair");
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
    assert.equal(issue?.pendingRunType, undefined);
    assert.deepEqual(db.issueSessions.peekIssueSessionWake("usertold", "issue-13")?.context, {
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
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-13c")?.runType, "queue_repair");
    assert.equal(issue?.lastGitHubFailureSource, "queue_eviction");
    assert.equal(issue?.lastGitHubFailureCheckName, "merge-steward/queue");
    assert.equal(issue?.lastGitHubFailureSignature, "queue_eviction::sha-13c::merge-steward/queue");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-13c" }]);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileRun keeps a pending wake when zombie recovery backoff defers retry", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-zombie-backoff-"));
  try {
    const { db, enqueueCalls, orchestrator } = createOrchestrator(baseDir);
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-zombie-backoff",
      issueKey: "USE-ZOMBIE-BACKOFF",
      branchName: "feat-zombie-backoff",
      factoryState: "implementing",
      zombieRecoveryAttempts: 1,
      lastZombieRecoveryAt: new Date().toISOString(),
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "recover zombie run",
    });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
      factoryState: "implementing",
      zombieRecoveryAttempts: 1,
      lastZombieRecoveryAt: issue.lastZombieRecoveryAt,
    });

    await (orchestrator as unknown as { reconcileRun: (targetRun: typeof run) => Promise<void> }).reconcileRun(run);

    const recoveredIssue = db.getIssue(issue.projectId, issue.linearIssueId);
    assert.equal(recoveredIssue?.activeRunId, undefined);
    assert.equal(recoveredIssue?.factoryState, "implementing");
    assert.equal(recoveredIssue?.zombieRecoveryAttempts, 1);
    assert.equal(db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId)?.runType, "implementation");
    assert.deepEqual(enqueueCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileRun does not treat a locally-owned no-thread launch as zombie", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-owned-launching-"));
  try {
    const { db, orchestrator } = createOrchestrator(baseDir);
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-zombie-owned-launch",
      issueKey: "USE-ZOMBIE-OWNED",
      branchName: "feat-zombie-owned-launch",
      factoryState: "implementing",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "launch still preparing",
    });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
      factoryState: "implementing",
    });

    const leaseService = (orchestrator as unknown as {
      leaseService: {
        acquire: (projectId: string, linearIssueId: string) => string | undefined;
      };
    }).leaseService;
    const leaseId = leaseService.acquire(issue.projectId, issue.linearIssueId);
    assert.ok(leaseId);

    await (orchestrator as unknown as { reconcileRun: (targetRun: typeof run) => Promise<void> }).reconcileRun(run);

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId);
    const updatedRun = db.runs.getRunById(run.id);
    const session = db.issueSessions.getIssueSession(issue.projectId, issue.linearIssueId);
    assert.equal(updatedIssue?.activeRunId, run.id);
    assert.equal(updatedIssue?.factoryState, "implementing");
    assert.equal(updatedRun?.status, "queued");
    assert.equal(updatedRun?.failureReason, undefined);
    assert.equal(session?.leaseId, leaseId);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("run defers recovered zombie retries until the backoff window expires", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-run-zombie-delay-"));
  try {
    const { db, orchestrator } = createOrchestrator(baseDir);
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-zombie-delay",
      issueKey: "USE-ZOMBIE-DELAY",
      branchName: "feat-zombie-delay",
      factoryState: "implementing",
      zombieRecoveryAttempts: 1,
      lastZombieRecoveryAt: new Date().toISOString(),
    });
    db.connection.prepare(`
      UPDATE issue_sessions
      SET last_run_type = 'implementation'
      WHERE project_id = ? AND linear_issue_id = ?
    `).run(issue.projectId, issue.linearIssueId);
    db.issueSessions.appendIssueSessionEvent({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType: "delegated",
      dedupeKey: `recovery:2:implementation:${issue.linearIssueId}`,
    });

    let prepareCalls = 0;
    let claimCalls = 0;
    const runLauncher = (orchestrator as unknown as {
      runLauncher: {
        prepareLaunchPlan: (...args: unknown[]) => unknown;
        claimRun: (...args: unknown[]) => unknown;
      };
    }).runLauncher;
    runLauncher.prepareLaunchPlan = (() => {
      prepareCalls += 1;
      return { prompt: "prompt", branchName: "use/issue-zombie-delay", worktreePath: path.join(baseDir, "wt") };
    }) as never;
    runLauncher.claimRun = (() => {
      claimCalls += 1;
      return undefined;
    }) as never;

    await orchestrator.run({ projectId: issue.projectId, issueId: issue.linearIssueId });

    assert.equal(prepareCalls, 0);
    assert.equal(claimCalls, 0);
    assert.equal(db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId)?.runType, "implementation");
    assert.equal(db.issueSessions.getIssueSession(issue.projectId, issue.linearIssueId)?.leaseId, undefined);

    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      lastZombieRecoveryAt: new Date(Date.now() - 31_000).toISOString(),
    });

    await orchestrator.run({ projectId: issue.projectId, issueId: issue.linearIssueId });

    assert.equal(prepareCalls, 1);
    assert.equal(claimCalls, 1);
  } finally {
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
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-13b2")?.runType, "queue_repair");
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
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-13d")?.runType, "queue_repair");
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
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-13e")?.runType, "queue_repair");
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
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "Implement USE-14",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-14", turnId: "turn-14" });
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

    await (orchestrator as unknown as { reconcileRun: (run: ReturnType<typeof db.runs.createRun>) => Promise<void> }).reconcileRun(
      db.runs.getRunById(run.id)!,
    );

    const updatedIssue = db.getIssue("usertold", "issue-14");
    const updatedRun = db.runs.getRunById(run.id);
    assert.equal(updatedIssue?.factoryState, "pr_open");
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedRun?.status, "failed");
    assert.equal(updatedRun?.failureReason, "Codex turn was interrupted");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileRun automatically requeues interrupted implementation runs when no PR exists yet", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-interrupted-implementation-retry-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const enqueueCalls: Array<{ projectId: string; issueId: string }> = [];
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-14a",
      issueKey: "USE-14A",
      branchName: "feat-interrupted-retry",
      factoryState: "implementing",
    });
    const issue = db.getIssue("usertold", "issue-14a");
    assert.ok(issue);
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "Implement USE-14A",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-14a", turnId: "turn-14a" });
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
        startThread: async () => ({ threadId: "thread-14a" }),
        steerTurn: async () => undefined,
        readThread: async () => ({
          id: "thread-14a",
          turns: [{ id: "turn-14a", status: "interrupted" }],
        }),
      } as never,
      { forProject: async () => undefined } as never,
      (projectId, issueId) => {
        enqueueCalls.push({ projectId, issueId });
      },
      pino({ enabled: false }),
    );

    await (orchestrator as unknown as { reconcileRun: (run: ReturnType<typeof db.runs.createRun>) => Promise<void> }).reconcileRun(
      db.runs.getRunById(run.id)!,
    );

    const updatedIssue = db.getIssue("usertold", "issue-14a");
    const updatedRun = db.runs.getRunById(run.id);
    assert.equal(updatedIssue?.factoryState, "delegated");
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedRun?.status, "failed");
    assert.equal(updatedRun?.failureReason, "Codex turn was interrupted");
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-14a")?.runType, "implementation");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-14a" }]);
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
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "Implement USE-14B",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-14b", turnId: "turn-14b" });
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
      db.issueSessions.acquireIssueSessionLease({
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

    await (orchestrator as unknown as { reconcileRun: (run: ReturnType<typeof db.runs.createRun>) => Promise<void> }).reconcileRun(
      db.runs.getRunById(run.id)!,
    );

    const updatedIssue = db.getIssue("usertold", "issue-14b");
    const updatedRun = db.runs.getRunById(run.id);
    const session = db.issueSessions.getIssueSession(issue.projectId, issue.linearIssueId);
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
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "ci_repair",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-15", turnId: "turn-15" });
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

    await (orchestrator as unknown as { reconcileRun: (run: { id: number }) => Promise<void> }).reconcileRun(db.runs.getRunById(run.id)!);

    const updatedIssue = db.getIssue("usertold", "issue-15");
    const updatedRun = db.runs.getRunById(run.id);
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
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: "usertold",
      linearIssueId: "issue-15f",
      runType: "queue_repair",
      promptText: "repair queue",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-15f", turnId: "turn-15f" });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-15f",
      activeRunId: run.id,
      factoryState: "repairing_queue",
    });
    assert.equal(
      db.issueSessions.acquireIssueSessionLease({
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

    await (orchestrator as unknown as { reconcileRun: (run: typeof run) => Promise<void> }).reconcileRun(db.runs.getRunById(run.id)!);
    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const updatedIssue = db.getIssue("usertold", "issue-15f");
    const updatedRun = db.runs.getRunById(run.id);
    const session = db.issueSessions.getIssueSession(issue.projectId, issue.linearIssueId);
    assert.equal(updatedIssue?.factoryState, "repairing_queue");
    assert.equal(updatedIssue?.queueRepairAttempts, 0);
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedRun?.status, "failed");
    assert.equal(updatedRun?.failureReason, "Codex turn was interrupted");
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-15f")?.runType, "queue_repair");
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
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: "usertold",
      linearIssueId: "issue-15q",
      runType: "queue_repair",
      promptText: "repair queue",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-15q", turnId: "turn-15q" });
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

    await (orchestrator as unknown as { reconcileRun: (run: typeof run) => Promise<void> }).reconcileRun(db.runs.getRunById(run.id)!);
    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const updatedIssue = db.getIssue("usertold", "issue-15q");
    const updatedRun = db.runs.getRunById(run.id);
    assert.equal(updatedIssue?.factoryState, "repairing_queue");
    assert.equal(updatedIssue?.queueRepairAttempts, 0);
    assert.equal(updatedIssue?.pendingRunType, undefined);
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-15q")?.runType, "queue_repair");
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedRun?.status, "failed");
    assert.equal(updatedRun?.failureReason, "Codex turn was interrupted");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-15q" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileRun requeues interrupted review_fix runs from the same requested-changes head", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-interrupted-review-fix-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = path.join(baseDir, "bin");
    const ghPath = path.join(fakeBin, "gh");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"headRefOid":"sha-review-stuck","state":"OPEN","reviewDecision":"CHANGES_REQUESTED","mergeStateStatus":"BLOCKED"}'
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`, "utf8");
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const enqueueCalls: Array<{ projectId: string; issueId: string }> = [];
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-15r",
      issueKey: "USE-15R",
      branchName: "feat-interrupted-review-fix",
      prNumber: 152,
      prState: "open",
      prHeadSha: "sha-review-stuck",
      prReviewState: "changes_requested",
      prCheckStatus: "success",
      reviewFixAttempts: 1,
      factoryState: "changes_requested",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
      sourceHeadSha: "sha-review-stuck",
      promptText: "fix review",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-15r", turnId: "turn-15r" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
      factoryState: "changes_requested",
    });

    const orchestrator = new RunOrchestrator(
      config,
      db,
      {
        startThread: async () => ({ threadId: "thread-15r" }),
        steerTurn: async () => undefined,
        readThread: async () => ({ id: "thread-15r", turns: [{ id: "turn-15r", status: "interrupted" }] }),
      } as never,
      { forProject: async () => undefined } as never,
      (projectId, issueId) => {
        enqueueCalls.push({ projectId, issueId });
      },
      pino({ enabled: false }),
    );

    await (orchestrator as unknown as { reconcileRun: (run: typeof run) => Promise<void> }).reconcileRun(db.runs.getRunById(run.id)!);

    const updatedIssue = db.getIssue("usertold", "issue-15r");
    const updatedRun = db.runs.getRunById(run.id);
    assert.equal(updatedIssue?.factoryState, "changes_requested");
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedIssue?.reviewFixAttempts, 1);
    assert.equal(updatedIssue?.pendingRunType, "review_fix");
    assert.equal(updatedRun?.status, "failed");
    assert.equal(updatedRun?.failureReason, "Requested-changes run was interrupted before PatchRelay could verify that a new PR head was published");
    assert.deepEqual(
      db.listIssuesReadyForExecution(),
      [{ projectId: "usertold", linearIssueId: "issue-15r" }],
    );
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-15r" }]);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileRun requeues interrupted branch_upkeep runs with branch-upkeep context", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-interrupted-branch-upkeep-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = path.join(baseDir, "bin");
    const ghPath = path.join(fakeBin, "gh");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"headRefOid":"sha-branch-upkeep-stuck","state":"OPEN","reviewDecision":"CHANGES_REQUESTED","mergeStateStatus":"DIRTY"}'
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`, "utf8");
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const enqueueCalls: Array<{ projectId: string; issueId: string }> = [];
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-15s",
      issueKey: "USE-15S",
      branchName: "feat-interrupted-branch-upkeep",
      prNumber: 153,
      prState: "open",
      prHeadSha: "sha-branch-upkeep-stuck",
      prReviewState: "changes_requested",
      prCheckStatus: "success",
      reviewFixAttempts: 2,
      factoryState: "changes_requested",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "branch_upkeep",
      sourceHeadSha: "sha-branch-upkeep-stuck",
      promptText: "repair branch",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-15s", turnId: "turn-15s" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
      factoryState: "changes_requested",
    });

    const orchestrator = new RunOrchestrator(
      config,
      db,
      {
        startThread: async () => ({ threadId: "thread-15s" }),
        steerTurn: async () => undefined,
        readThread: async () => ({ id: "thread-15s", turns: [{ id: "turn-15s", status: "interrupted" }] }),
      } as never,
      { forProject: async () => undefined } as never,
      (projectId, issueId) => {
        enqueueCalls.push({ projectId, issueId });
      },
      pino({ enabled: false }),
    );

    await (orchestrator as unknown as { reconcileRun: (run: typeof run) => Promise<void> }).reconcileRun(db.runs.getRunById(run.id)!);

    const updatedIssue = db.getIssue("usertold", "issue-15s");
    const updatedRun = db.runs.getRunById(run.id);
    const pendingContext = updatedIssue?.pendingRunContextJson
      ? JSON.parse(updatedIssue.pendingRunContextJson) as Record<string, unknown>
      : undefined;
    assert.equal(updatedIssue?.factoryState, "changes_requested");
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedIssue?.reviewFixAttempts, 2);
    assert.equal(updatedIssue?.pendingRunType, "branch_upkeep");
    assert.equal(updatedRun?.status, "failed");
    assert.equal(pendingContext?.branchUpkeepRequired, true);
    assert.equal(pendingContext?.wakeReason, "branch_upkeep");
    assert.deepEqual(
      db.listIssuesReadyForExecution(),
      [{ projectId: "usertold", linearIssueId: "issue-15s" }],
    );
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-15s" }]);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("completed review_fix queues branch_upkeep when the PR is still dirty", async () => {
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
      prHeadSha: "sha-review-before",
      prReviewState: "changes_requested",
      factoryState: "changes_requested",
      reviewFixAttempts: 1,
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
      sourceHeadSha: "sha-review-before",
      promptText: "review fix",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-review-dirty", turnId: "turn-review-dirty" });
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

    await (orchestrator as unknown as { reconcileRun: (run: typeof run) => Promise<void> }).reconcileRun(db.runs.getRunById(run.id)!);

    const updatedIssue = db.getIssue("usertold", "issue-review-dirty");
    const wake = db.issueSessions.peekIssueSessionWake("usertold", "issue-review-dirty");
    const updatedRun = db.runs.getRunById(run.id);
    assert.equal(updatedRun?.status, "completed");
    assert.equal(updatedIssue?.factoryState, "changes_requested");
    assert.equal(updatedIssue?.pendingRunType, undefined);
    assert.equal(wake?.runType, "branch_upkeep");
    assert.match(JSON.stringify(wake?.context ?? {}), /branchUpkeepRequired/);
    assert.match(JSON.stringify(wake?.context ?? {}), /GitHub still reports PR #21 as DIRTY/);
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-review-dirty" }]);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("completed review_fix escalates when the PR head did not advance", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-review-fix-same-head-"));
  const oldPath = process.env.PATH;
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const enqueueCalls: Array<{ projectId: string; issueId: string }> = [];
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-review-same-head",
      issueKey: "USE-REVIEW-SAME-HEAD",
      branchName: "feat-review-same-head",
      prNumber: 22,
      prState: "open",
      prHeadSha: "sha-review-same-head",
      prReviewState: "changes_requested",
      factoryState: "changes_requested",
      reviewFixAttempts: 1,
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
      sourceHeadSha: "sha-review-same-head",
      promptText: "review fix",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-review-same-head", turnId: "turn-review-same-head" });
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
  printf '{"headRefOid":"sha-review-same-head","state":"OPEN","reviewDecision":"CHANGES_REQUESTED","mergeStateStatus":"CLEAN"}'
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
        startThread: async () => ({ threadId: "thread-review-same-head" }),
        steerTurn: async () => undefined,
        readThread: async () => ({ id: "thread-review-same-head", turns: [{ id: "turn-review-same-head", status: "completed", items: [] }] }),
      } as never,
      { forProject: async () => undefined } as never,
      (projectId, issueId) => {
        enqueueCalls.push({ projectId, issueId });
      },
      pino({ enabled: false }),
    );

    await (orchestrator as unknown as { reconcileRun: (run: typeof run) => Promise<void> }).reconcileRun(db.runs.getRunById(run.id)!);

    const updatedIssue = db.getIssue("usertold", "issue-review-same-head");
    const updatedRun = db.runs.getRunById(run.id);
    assert.equal(updatedIssue?.factoryState, "escalated");
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedRun?.status, "failed");
    assert.match(updatedRun?.failureReason ?? "", /without pushing a new head/);
    assert.deepEqual(enqueueCalls, []);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("live completion and reconciliation both reject review_fix runs that never publish a newer head", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-review-fix-parity-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = writeGhViewScript(baseDir, '{"headRefOid":"sha-review-parity","state":"OPEN","reviewDecision":"CHANGES_REQUESTED","mergeStateStatus":"CLEAN"}');
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const liveDir = path.join(baseDir, "live");
    const reconcileDir = path.join(baseDir, "reconcile");
    mkdirSync(liveDir, { recursive: true });
    mkdirSync(reconcileDir, { recursive: true });

    const liveSetup = createOrchestrator(liveDir, undefined, {
      startThread: async () => ({ threadId: "thread-review-parity-live" }),
      steerTurn: async () => undefined,
      readThread: async () => ({
        id: "thread-review-parity-live",
        turns: [{ id: "turn-review-parity-live", status: "completed", items: [] }],
      }),
    });
    const liveIssue = liveSetup.db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-review-parity-live",
      issueKey: "USE-REVIEW-PARITY",
      branchName: "feat-review-parity",
      prNumber: 41,
      prState: "open",
      prHeadSha: "sha-review-parity",
      prReviewState: "changes_requested",
      prCheckStatus: "success",
      factoryState: "changes_requested",
    });
    const liveRun = liveSetup.db.runs.createRun({
      issueId: liveIssue.id,
      projectId: liveIssue.projectId,
      linearIssueId: liveIssue.linearIssueId,
      runType: "review_fix",
      sourceHeadSha: "sha-review-parity",
      promptText: "repair review feedback",
    });
    liveSetup.db.runs.updateRunThread(liveRun.id, { threadId: "thread-review-parity-live", turnId: "turn-review-parity-live" });
    liveSetup.db.upsertIssue({
      projectId: liveIssue.projectId,
      linearIssueId: liveIssue.linearIssueId,
      activeRunId: liveRun.id,
      factoryState: "changes_requested",
    });
    const liveLeaseId = "lease-review-parity-live";
    assert.equal(
      liveSetup.db.issueSessions.acquireIssueSessionLease({
        projectId: liveIssue.projectId,
        linearIssueId: liveIssue.linearIssueId,
        leaseId: liveLeaseId,
        workerId: "worker-review-parity-live",
        leasedUntil: "2030-04-06T10:05:00.000Z",
        now: "2030-04-06T10:00:00.000Z",
      }),
      true,
    );
    ((liveSetup.orchestrator as unknown as { activeSessionLeases: Map<string, string> }).activeSessionLeases)
      .set(`${liveIssue.projectId}:${liveIssue.linearIssueId}`, liveLeaseId);

    await liveSetup.orchestrator.handleCodexNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-review-parity-live",
        turn: {
          id: "turn-review-parity-live",
          status: "completed",
        },
      },
    });

    const reconcileSetup = createOrchestrator(reconcileDir, undefined, {
      startThread: async () => ({ threadId: "thread-review-parity-reconcile" }),
      steerTurn: async () => undefined,
      readThread: async () => ({
        id: "thread-review-parity-reconcile",
        turns: [{ id: "turn-review-parity-reconcile", status: "completed", items: [] }],
      }),
    });
    const reconcileIssue = reconcileSetup.db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-review-parity-reconcile",
      issueKey: "USE-REVIEW-PARITY",
      branchName: "feat-review-parity",
      prNumber: 42,
      prState: "open",
      prHeadSha: "sha-review-parity",
      prReviewState: "changes_requested",
      prCheckStatus: "success",
      factoryState: "changes_requested",
    });
    const reconcileRun = reconcileSetup.db.runs.createRun({
      issueId: reconcileIssue.id,
      projectId: reconcileIssue.projectId,
      linearIssueId: reconcileIssue.linearIssueId,
      runType: "review_fix",
      sourceHeadSha: "sha-review-parity",
      promptText: "repair review feedback",
    });
    reconcileSetup.db.runs.updateRunThread(reconcileRun.id, { threadId: "thread-review-parity-reconcile", turnId: "turn-review-parity-reconcile" });
    reconcileSetup.db.upsertIssue({
      projectId: reconcileIssue.projectId,
      linearIssueId: reconcileIssue.linearIssueId,
      activeRunId: reconcileRun.id,
      factoryState: "changes_requested",
    });
    const reconcileLeaseId = "lease-review-parity-reconcile";
    assert.equal(
      reconcileSetup.db.issueSessions.acquireIssueSessionLease({
        projectId: reconcileIssue.projectId,
        linearIssueId: reconcileIssue.linearIssueId,
        leaseId: reconcileLeaseId,
        workerId: "worker-review-parity-reconcile",
        leasedUntil: "2030-04-06T10:05:00.000Z",
        now: "2030-04-06T10:00:00.000Z",
      }),
      true,
    );
    ((reconcileSetup.orchestrator as unknown as { activeSessionLeases: Map<string, string> }).activeSessionLeases)
      .set(`${reconcileIssue.projectId}:${reconcileIssue.linearIssueId}`, reconcileLeaseId);

    await reconcileSetup.orchestrator.reconcileRun(reconcileSetup.db.runs.getRunById(reconcileRun.id)!);

    assert.deepEqual(
      normalizeRunOutcomeForComparison(summarizeRunOutcome(liveSetup.db, "issue-review-parity-live", liveRun.id)),
      normalizeRunOutcomeForComparison(summarizeRunOutcome(reconcileSetup.db, "issue-review-parity-reconcile", reconcileRun.id)),
    );
    assert.equal(liveSetup.db.getIssue("usertold", "issue-review-parity-live")?.factoryState, "escalated");
    assert.equal(reconcileSetup.db.getIssue("usertold", "issue-review-parity-reconcile")?.factoryState, "escalated");
    assert.match(
      liveSetup.db.runs.getRunById(liveRun.id)?.failureReason ?? "",
      /same SHA back to review/,
    );
    assert.match(
      reconcileSetup.db.runs.getRunById(reconcileRun.id)?.failureReason ?? "",
      /same SHA back to review/,
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("completion notifications are ignored after the issue-session lease is lost", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-lease-loss-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = writeGhViewScript(baseDir, '{"headRefOid":"sha-lease-loss","state":"OPEN","reviewDecision":"CHANGES_REQUESTED","mergeStateStatus":"CLEAN"}');
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, orchestrator } = createOrchestrator(baseDir);
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-lease-loss",
      issueKey: "USE-LEASE-LOSS",
      branchName: "feat-lease-loss",
      prNumber: 51,
      prState: "open",
      prHeadSha: "sha-lease-loss",
      prReviewState: "changes_requested",
      prCheckStatus: "success",
      factoryState: "changes_requested",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
      sourceHeadSha: "sha-lease-loss",
      promptText: "repair review feedback",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-lease-loss", turnId: "turn-lease-loss" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
      factoryState: "changes_requested",
    });
    const leaseId = "lease-review-lease-loss";
    assert.equal(
      db.issueSessions.acquireIssueSessionLease({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        leaseId,
        workerId: "worker-lease-loss",
        leasedUntil: "2030-04-06T10:05:00.000Z",
        now: "2030-04-06T10:00:00.000Z",
      }),
      true,
    );
    ((orchestrator as unknown as { activeSessionLeases: Map<string, string> }).activeSessionLeases)
      .set(`${issue.projectId}:${issue.linearIssueId}`, leaseId);
    db.issueSessions.releaseIssueSessionLease(issue.projectId, issue.linearIssueId, leaseId);

    await orchestrator.handleCodexNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-lease-loss",
        turn: {
          id: "turn-lease-loss",
          status: "completed",
        },
      },
    });

    const untouchedIssue = db.getIssue("usertold", "issue-lease-loss");
    const untouchedRun = db.runs.getRunById(run.id);
    assert.equal(untouchedIssue?.activeRunId, run.id);
    assert.equal(untouchedIssue?.factoryState, "changes_requested");
    assert.equal(untouchedRun?.status, "running");
    assert.equal(untouchedRun?.failureReason, undefined);
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
      reviewFixAttempts: 10,
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
      db.issueSessions.acquireIssueSessionLease({
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
      resolveRequestedChangesWakeContext: (
        issue: typeof issue,
        runType: "review_fix" | "branch_upkeep",
        context: Record<string, unknown> | undefined,
        project: AppConfig["projects"][number],
      ) => Promise<Record<string, unknown> | undefined>;
    }).resolveRequestedChangesWakeContext(issue, "review_fix", undefined, config.projects[0]!);

    assert.equal(context?.branchUpkeepRequired, true);
    assert.equal(context?.wakeReason, "branch_upkeep");
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

test("review-fix retry rehydrates live review context before relaunch", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-review-retry-context-"));
  const oldPath = process.env.PATH;
  try {
    const { config, db, orchestrator } = createOrchestrator(baseDir);
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-review-retry-context",
      issueKey: "USE-RETRY-CONTEXT",
      prNumber: 32,
      prState: "open",
      prHeadSha: "sha-stale",
      prReviewState: "changes_requested",
      factoryState: "changes_requested",
      reviewFixAttempts: 1,
    });

    const fakeBin = path.join(baseDir, "fake-bin");
    mkdirSync(fakeBin, { recursive: true });
    const ghPath = path.join(fakeBin, "gh");
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"headRefOid":"sha-live","state":"OPEN","reviewDecision":"CHANGES_REQUESTED","mergeStateStatus":"BLOCKED"}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/owner/repo/pulls/32/reviews?per_page=100" ]; then
  printf '[{"id":901,"state":"CHANGES_REQUESTED","body":"Please fix the checkout eligibility for prelaunch accounts.","commit_id":"commit-901","html_url":"https://github.com/owner/repo/pull/32#pullrequestreview-901","user":{"login":"review-quill"}}]'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/owner/repo/pulls/32/reviews/901/comments?per_page=100" ]; then
  printf '[{"body":"allow_trial should stay false once the user has any prior subscription history.","path":"src/backend/services/billing-service.ts","line":633,"side":"RIGHT","html_url":"https://github.com/owner/repo/pull/32#discussion_r901","user":{"login":"review-quill"}}]'
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`);
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const leaseId = "lease-review-retry-context";
    assert.equal(
      db.issueSessions.acquireIssueSessionLease({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        leaseId,
        workerId: "worker-review-retry-context",
        leasedUntil: "2030-04-06T10:05:00.000Z",
        now: "2030-04-06T10:00:00.000Z",
      }),
      true,
    );
    ((orchestrator as unknown as { activeSessionLeases: Map<string, string> }).activeSessionLeases)
      .set(`${issue.projectId}:${issue.linearIssueId}`, leaseId);

    const context = await (orchestrator as unknown as {
      resolveRequestedChangesWakeContext: (
        issue: typeof issue,
        runType: "review_fix" | "branch_upkeep",
        context: Record<string, unknown> | undefined,
        project: AppConfig["projects"][number],
      ) => Promise<Record<string, unknown> | undefined>;
    }).resolveRequestedChangesWakeContext(issue, "review_fix", {
      reviewBody: "Operator requested retry of review-fix work.",
      source: "operator_retry",
    }, config.projects[0]!);

    assert.equal(context?.headSha, "sha-live");
    assert.equal(context?.reviewId, 901);
    assert.equal(context?.reviewCommitId, "commit-901");
    assert.equal(context?.reviewUrl, "https://github.com/owner/repo/pull/32#pullrequestreview-901");
    assert.equal(context?.reviewerName, "review-quill");
    assert.match(String(context?.reviewBody ?? ""), /checkout eligibility for prelaunch accounts/);
    assert.deepEqual(context?.reviewComments, [{
      body: "allow_trial should stay false once the user has any prior subscription history.",
      path: "src/backend/services/billing-service.ts",
      line: 633,
      side: "RIGHT",
      url: "https://github.com/owner/repo/pull/32#discussion_r901",
      authorLogin: "review-quill",
    }]);

    const updatedIssue = db.getIssue("usertold", "issue-review-retry-context");
    assert.equal(updatedIssue?.prHeadSha, "sha-live");
    assert.equal(updatedIssue?.prReviewState, "changes_requested");
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("completed notification for a released run is ignored", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-notification-ignore-released-"));
  const oldPath = process.env.PATH;
  try {
    const { db, orchestrator } = createOrchestrator(baseDir, undefined, {
      startThread: async () => ({ threadId: "thread-ignore-released" }),
      steerTurn: async () => undefined,
      readThread: async () => ({
        id: "thread-ignore-released",
        turns: [{ id: "turn-ignore-released", status: "completed", items: [] }],
      }),
    });
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-ignore-released",
      issueKey: "USE-IGNORE-RELEASED",
      factoryState: "delegated",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "implement",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-ignore-released", turnId: "turn-ignore-released" });
    db.runs.finishRun(run.id, { status: "released", failureReason: "Issue was un-delegated during active run" });

    const leaseId = "lease-ignore-released";
    assert.equal(
      db.issueSessions.acquireIssueSessionLease({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        leaseId,
        workerId: "worker-ignore-released",
        leasedUntil: "2030-04-06T10:05:00.000Z",
        now: "2030-04-06T10:00:00.000Z",
      }),
      true,
    );
    ((orchestrator as unknown as { activeSessionLeases: Map<string, string> }).activeSessionLeases)
      .set(`${issue.projectId}:${issue.linearIssueId}`, leaseId);

    await orchestrator.handleCodexNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-ignore-released",
        turn: {
          id: "turn-ignore-released",
          status: "completed",
        },
      },
    });

    const untouchedRun = db.runs.getRunById(run.id);
    const untouchedIssue = db.getIssue(issue.projectId, issue.linearIssueId);
    assert.equal(untouchedRun?.status, "released");
    assert.equal(untouchedRun?.failureReason, "Issue was un-delegated during active run");
    assert.equal(untouchedIssue?.factoryState, "delegated");
    assert.equal(untouchedIssue?.activeRunId, undefined);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconciliation repairs stale undelegated local state from live Linear before releasing an active run", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-delegation-authority-"));
  try {
    const { db, orchestrator } = createOrchestrator(
      baseDir,
      {
        forProject: async () => ({
          getIssue: async () => ({
            id: "issue-delegation-authority",
            identifier: "USE-208",
            title: "Repair stale delegation during reconciliation",
            teamId: "USE",
            teamKey: "USE",
            delegateId: "patchrelay-actor",
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
        }),
      },
      {
        startThread: async () => ({ threadId: "thread-1" }),
        steerTurn: async () => undefined,
        readThread: async () => ({
          id: "thread-1",
          turns: [{ id: "turn-1", status: "running", items: [] }],
        }),
      },
    );
    const installation = db.linearInstallations.upsertLinearInstallation({
      workspaceId: "workspace-1",
      actorId: "patchrelay-actor",
      accessTokenCiphertext: "ciphertext",
      scopesJson: "[]",
    });
    db.linearInstallations.linkProjectInstallation("usertold", installation.id);

    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-delegation-authority",
      issueKey: "USE-208",
      title: "Repair stale delegation during reconciliation",
      delegatedToPatchRelay: false,
      factoryState: "implementing",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-1" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
      delegatedToPatchRelay: false,
      factoryState: "implementing",
    });
    (orchestrator as unknown as {
      leaseService: { acquire: (projectId: string, linearIssueId: string) => string | undefined };
    }).leaseService.acquire("usertold", "issue-delegation-authority");

    await (orchestrator as unknown as {
      runReconciler: {
        reconcile: (params: { run: typeof run; issue: NonNullable<ReturnType<typeof db.getIssue>>; recoveryLease: boolean | "owned" }) => Promise<void>;
      };
    }).runReconciler.reconcile({
      run: db.runs.getRunById(run.id)!,
      issue: db.getIssue("usertold", "issue-delegation-authority")!,
      recoveryLease: "owned",
    });

    const updatedIssue = db.getIssue("usertold", "issue-delegation-authority");
    const updatedRun = db.runs.getRunById(run.id);
    assert.equal(updatedIssue?.delegatedToPatchRelay, true);
    assert.equal(updatedIssue?.activeRunId, run.id);
    assert.equal(updatedRun?.status, "running");
    assert.equal(
      db.issueSessions.listIssueSessionEvents("usertold", "issue-delegation-authority")
        .some((event) => event.eventType === "run_released_authority"),
      false,
    );
    const audit = db.issueSessions.listIssueSessionEvents("usertold", "issue-delegation-authority")
      .findLast((event) => event.eventType === "delegation_observed");
    assert.ok(audit?.eventJson);
    const parsed = JSON.parse(audit.eventJson) as { reason?: string; appliedDelegatedToPatchRelay?: boolean };
    assert.equal(parsed.reason, "live_linear_confirmed_issue_is_still_delegated");
    assert.equal(parsed.appliedDelegatedToPatchRelay, true);
  } finally {
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
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-queue-priority")?.runType, "queue_repair");
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
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "ci_repair",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-15b", turnId: "turn-15b" });
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

    await (orchestrator as unknown as { reconcileRun: (run: { id: number }) => Promise<void> }).reconcileRun(db.runs.getRunById(run.id)!);
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
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "ci_repair",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-16", turnId: "turn-16" });
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

    await (orchestrator as unknown as { reconcileRun: (run: { id: number }) => Promise<void> }).reconcileRun(db.runs.getRunById(run.id)!);

    const updatedIssue = db.getIssue("usertold", "issue-16");
    const updatedRun = db.runs.getRunById(run.id);
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
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "queue_repair",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-17", turnId: "turn-17" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });

    await (orchestrator as unknown as { reconcileRun: (run: { id: number }) => Promise<void> }).reconcileRun(db.runs.getRunById(run.id)!);

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const updatedIssue = db.getIssue("usertold", "issue-17");
    const updatedRun = db.runs.getRunById(run.id);
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
    const before = db.getIssue("usertold", "issue-15");
    assert.ok(before);

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-15");
    assert.equal(issue?.factoryState, "awaiting_queue");
    assert.equal(issue?.pendingRunType, undefined);
    assert.equal(issue?.updatedAt, before.updatedAt);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileIdleIssues re-enqueues queue_repair when a fresh steward incident fires after a prior failed attempt", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-fresh-incident-"));
  try {
    const { db, enqueueCalls, orchestrator } = createOrchestrator(baseDir);
    const attemptedAt = "2026-04-14T20:53:32.000Z";
    const freshFailureAt = "2026-04-14T22:10:00.000Z";
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-fresh-incident",
      issueKey: "USE-FI",
      branchName: "feat-fresh-incident",
      prNumber: 59,
      prState: "open",
      prHeadSha: "sha-pr",
      prReviewState: "approved",
      prCheckStatus: "failed",
      factoryState: "repairing_queue",
      lastGitHubFailureSource: "queue_eviction",
      lastGitHubFailureHeadSha: "sha-pr",
      lastGitHubFailureSignature: "queue_eviction::sha-pr::merge-steward/queue",
      lastGitHubFailureCheckName: "merge-steward/queue",
      lastGitHubFailureAt: freshFailureAt,
      lastAttemptedFailureHeadSha: "sha-pr",
      lastAttemptedFailureSignature: "queue_eviction::sha-pr::merge-steward/queue",
      lastAttemptedFailureAt: attemptedAt,
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-fresh-incident");
    assert.equal(issue?.factoryState, "repairing_queue");
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-fresh-incident")?.runType, "queue_repair");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-fresh-incident" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileIdleIssues still dedupes queue_repair when the last attempt covered the current incident", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-dedupe-same-incident-"));
  try {
    const { db, enqueueCalls, orchestrator } = createOrchestrator(baseDir);
    const sameAt = "2026-04-14T20:53:32.000Z";
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-dedupe-same",
      issueKey: "USE-DS",
      branchName: "feat-dedupe-same",
      prNumber: 60,
      prState: "open",
      prHeadSha: "sha-pr",
      prReviewState: "approved",
      prCheckStatus: "failed",
      factoryState: "repairing_queue",
      lastGitHubFailureSource: "queue_eviction",
      lastGitHubFailureHeadSha: "sha-pr",
      lastGitHubFailureSignature: "queue_eviction::sha-pr::merge-steward/queue",
      lastGitHubFailureCheckName: "merge-steward/queue",
      lastGitHubFailureAt: sameAt,
      lastAttemptedFailureHeadSha: "sha-pr",
      lastAttemptedFailureSignature: "queue_eviction::sha-pr::merge-steward/queue",
      lastAttemptedFailureAt: sameAt,
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-dedupe-same");
    assert.equal(issue?.factoryState, "repairing_queue");
    assert.equal(issue?.pendingRunType, undefined);
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-dedupe-same"), undefined);
    assert.deepEqual(enqueueCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
