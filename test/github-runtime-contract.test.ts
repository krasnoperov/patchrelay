import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import test from "node:test";
import { assertIssuePhase } from "./assert-issue-phase.ts";
import { PatchRelayDatabase } from "../src/db.ts";
import type { GitHubCiSnapshotResolver, GitHubFailureContextResolver } from "../src/github-failure-context.ts";
import { GitHubWebhookHandler } from "../src/github-webhook-handler.ts";
import { normalizeGitHubWebhook } from "../src/github-webhooks.ts";
import { RunTaskPlanner } from "../src/run-task-planner.ts";
import type { AppConfig, GitHubWebhookPayload, LinearClient } from "../src/types.ts";

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
  options?: {
    linearProvider?: { forProject(projectId: string): Promise<LinearClient | undefined> };
    failureContextResolver?: GitHubFailureContextResolver;
    ciSnapshotResolver?: GitHubCiSnapshotResolver;
    fetchImpl?: typeof fetch;
  },
) {
  const config = createConfig(baseDir);
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();
  const enqueueCalls: Array<{ projectId: string; issueId: string }> = [];
  const handler = new GitHubWebhookHandler(
    config,
    db,
    (options?.linearProvider ?? { forProject: async () => undefined }) as never,
    (projectId, issueId) => {
      enqueueCalls.push({ projectId, issueId });
    },
    pino({ enabled: false }),
    { steerTurn: async () => undefined } as never,
    undefined,
    options?.failureContextResolver,
    options?.ciSnapshotResolver,
    options?.fetchImpl,
  );
  return { db, enqueueCalls, handler };
}

function buildApprovedReviewPayload(params: {
  branch: string;
  headSha: string;
  prNumber: number;
  prAuthorLogin?: string;
  prTitle?: string;
  prBody?: string;
}): string {
  return JSON.stringify({
    action: "submitted",
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: params.prNumber,
      html_url: `https://github.com/owner/repo/pull/${params.prNumber}`,
      title: params.prTitle ?? `PR for #${params.prNumber}`,
      body: params.prBody ?? "",
      state: "open",
      merged: false,
      user: { login: params.prAuthorLogin ?? "patchrelay[bot]" },
      head: { ref: params.branch, sha: params.headSha },
      base: { ref: "main" },
    },
    review: {
      state: "approved",
      body: "Looks good to me.",
      user: { login: "reviewbot" },
    },
  });
}

function buildChangesRequestedReviewPayload(params: {
  branch: string;
  headSha: string;
  prNumber: number;
  prAuthorLogin: string;
  reviewId?: number;
  reviewCommitId?: string;
  prTitle?: string;
  prBody?: string;
}): string {
  return JSON.stringify({
    action: "submitted",
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: params.prNumber,
      html_url: `https://github.com/owner/repo/pull/${params.prNumber}`,
      title: params.prTitle ?? `PR for #${params.prNumber}`,
      body: params.prBody ?? "",
      state: "open",
      merged: false,
      user: { login: params.prAuthorLogin },
      head: { ref: params.branch, sha: params.headSha },
      base: { ref: "main" },
    },
    review: {
      id: params.reviewId ?? 901,
      state: "changes_requested",
      body: "Please tighten this up.",
      commit_id: params.reviewCommitId ?? params.headSha,
      user: { login: "reviewbot" },
    },
  });
}

function buildOpenedPrPayload(params: {
  branch: string;
  headSha: string;
  prNumber: number;
  prAuthorLogin?: string;
  prTitle?: string;
  prBody?: string;
}): string {
  return JSON.stringify({
    action: "opened",
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: params.prNumber,
      html_url: `https://github.com/owner/repo/pull/${params.prNumber}`,
      title: params.prTitle ?? `PR for #${params.prNumber}`,
      body: params.prBody ?? "",
      state: "open",
      merged: false,
      user: { login: params.prAuthorLogin ?? "human-dev" },
      head: { ref: params.branch, sha: params.headSha },
      base: { ref: "main" },
    },
  });
}

function createJsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

function resolveRuntimeTask(db: PatchRelayDatabase, projectId: string, issueId: string) {
  const issue = db.getIssue(projectId, issueId);
  assert.ok(issue);
  return new RunTaskPlanner(db).resolveRunTask(issue);
}

function buildSuccessfulCheckRunPayload(params: {
  branch: string;
  headSha: string;
  prNumber: number;
  checkName?: string;
}): string {
  return JSON.stringify({
    action: "completed",
    repository: { full_name: "owner/repo" },
    check_run: {
      conclusion: "success",
      name: params.checkName ?? "Tests",
      html_url: `https://github.com/owner/repo/actions/runs/${params.prNumber}`,
      details_url: `https://github.com/owner/repo/actions/runs/${params.prNumber}`,
      head_sha: params.headSha,
      output: {
        title: "Tests passed",
        summary: "All required checks succeeded.",
      },
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

function buildPendingCheckRunPayload(params: {
  branch: string;
  headSha: string;
  prNumber: number;
  checkName?: string;
  action?: string;
}): string {
  return JSON.stringify({
    action: params.action ?? "in_progress",
    repository: { full_name: "owner/repo" },
    check_run: {
      conclusion: null,
      status: "in_progress",
      name: params.checkName ?? "Tests",
      html_url: `https://github.com/owner/repo/actions/runs/${params.prNumber}`,
      details_url: `https://github.com/owner/repo/actions/runs/${params.prNumber}`,
      head_sha: params.headSha,
      output: {
        title: "Tests are running",
        summary: "Required checks are still in progress.",
      },
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

function buildFailedCheckRunPayload(params: {
  branch: string;
  headSha: string;
  prNumber: number;
  checkName?: string;
}): string {
  return JSON.stringify({
    action: "completed",
    repository: { full_name: "owner/repo" },
    check_run: {
      conclusion: "failure",
      name: params.checkName ?? "Tests",
      html_url: `https://github.com/owner/repo/actions/runs/${params.prNumber}`,
      details_url: `https://github.com/owner/repo/actions/runs/${params.prNumber}`,
      head_sha: params.headSha,
      output: {
        title: "Tests failed",
        summary: "Required checks failed.",
      },
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

function buildPrCommentPayload(params: {
  prNumber: number;
  body: string;
  author: string;
}): string {
  return JSON.stringify({
    action: "created",
    issue: {
      number: params.prNumber,
      pull_request: {
        url: `https://api.github.com/repos/owner/repo/pulls/${params.prNumber}`,
      },
    },
    comment: {
      body: params.body,
      user: {
        login: params.author,
        type: "User",
      },
    },
  });
}

function buildTerminalPrPayload(params: {
  action: "closed";
  branch: string;
  headSha: string;
  prNumber: number;
  merged: boolean;
  prAuthorLogin?: string;
}): string {
  return JSON.stringify({
    action: params.action,
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: params.prNumber,
      html_url: `https://github.com/owner/repo/pull/${params.prNumber}`,
      state: "closed",
      merged: params.merged,
      user: { login: params.prAuthorLogin ?? "patchrelay[bot]" },
      head: { ref: params.branch, sha: params.headSha },
      base: { ref: "main" },
    },
  });
}

function buildLabeledPrPayload(params: {
  branch: string;
  headSha: string;
  prNumber: number;
  labels: string[];
}): string {
  return JSON.stringify({
    action: "labeled",
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: params.prNumber,
      html_url: `https://github.com/owner/repo/pull/${params.prNumber}`,
      state: "open",
      merged: false,
      user: { login: "patchrelay[bot]" },
      labels: params.labels.map((name) => ({ name })),
      head: { ref: params.branch, sha: params.headSha },
      base: { ref: "main" },
    },
    label: { name: params.labels.at(-1) ?? "queue" },
  });
}

function buildSynchronizePrPayload(params: {
  branch: string;
  headSha: string;
  prNumber: number;
  prAuthorLogin?: string;
}): string {
  return JSON.stringify({
    action: "synchronize",
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: params.prNumber,
      html_url: `https://github.com/owner/repo/pull/${params.prNumber}`,
      state: "open",
      merged: false,
      user: { login: params.prAuthorLogin ?? "patchrelay[bot]" },
      head: { ref: params.branch, sha: params.headSha },
      base: { ref: "main" },
    },
  });
}

test("review approval updates GitHub state but does not queue new PatchRelay work", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-runtime-approved-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-approval",
      issueKey: "USE-10",
      branchName: "feat-approval",
      prNumber: 10,
      prState: "open",
      workflowOutcome: undefined,
    });

    await handler.processGitHubWebhookEvent({
      eventType: "pull_request_review",
      rawBody: buildApprovedReviewPayload({
        branch: "feat-approval",
        headSha: "sha-approval",
        prNumber: 10,
      }),
    });

    const issue = db.getIssue("usertold", "issue-approval");
    assert.equal(issue?.prReviewState, "approved");
    assert.equal(issue?.activeRunId, undefined);
    assert.deepEqual(enqueueCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("merged PatchRelay PR moves the Linear issue to a completed state", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-runtime-merged-linear-state-"));
  try {
    const setIssueStateCalls: string[] = [];
    const { db, handler } = createHandler(baseDir, {
      linearProvider: {
        forProject: async () => ({
          getIssue: async () => ({
            id: "issue-merge-linear",
          identifier: "USE-14",
          title: "Merged issue",
          description: "",
          url: "https://linear.app/usertold/issue/USE-14",
          teamId: "team-use",
          teamKey: "USE",
          stateId: "state-review",
          stateName: "In Review",
          stateType: "started",
          workflowStates: [
            { id: "state-review", name: "In Review", type: "started" },
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
            id: "issue-merge-linear",
            identifier: "USE-14",
            title: "Merged issue",
            description: "",
            url: "https://linear.app/usertold/issue/USE-14",
            teamId: "team-use",
            teamKey: "USE",
            stateId: "state-done",
            stateName: "Done",
            stateType: "completed",
            workflowStates: [
              { id: "state-review", name: "In Review", type: "started" },
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
      },
    });

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-merge-linear",
      issueKey: "USE-14",
      branchName: "feat-merge-linear",
      prNumber: 14,
      prState: "open",
      prHeadSha: "merge-sha-1",
      prAuthorLogin: "patchrelay[bot]",
      workflowOutcome: undefined,
      currentLinearState: "In Review",
      currentLinearStateType: "started",
    });

    const payload = buildTerminalPrPayload({
      action: "closed",
      branch: "feat-merge-linear",
      headSha: "merge-sha-1",
      prNumber: 14,
      merged: true,
      prAuthorLogin: "patchrelay[bot]",
    });
    await handler.processGitHubWebhookEvent({
      eventType: "pull_request",
      rawBody: payload,
    });

    const issue = db.getIssue("usertold", "issue-merge-linear");
    assertIssuePhase(issue, "done");
    assert.equal(issue?.currentLinearState, "Done");
    assert.equal(issue?.currentLinearStateType, "completed");
    assert.deepEqual(setIssueStateCalls, ["Done"]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("closed non-merged PR on a completed issue preserves done state and clears stale PR review signals", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-runtime-closed-done-"));
  try {
    const setIssueStateCalls: string[] = [];
    const { db, handler } = createHandler(baseDir, {
      linearProvider: {
        forProject: async () => ({
          getIssue: async () => ({
            id: "issue-closed-done",
            identifier: "USE-108",
            title: "Analysis-only issue",
            description: "",
            url: "https://linear.app/usertold/issue/USE-108",
            teamId: "team-use",
            teamKey: "USE",
            stateId: "state-done",
            stateName: "Done",
            stateType: "completed",
            workflowStates: [
              { id: "state-review", name: "In Review", type: "started" },
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
              id: "issue-closed-done",
              identifier: "USE-108",
              title: "Analysis-only issue",
              description: "",
              url: "https://linear.app/usertold/issue/USE-108",
              teamId: "team-use",
              teamKey: "USE",
              stateId: "state-done",
              stateName: "Done",
              stateType: "completed",
              workflowStates: [
                { id: "state-review", name: "In Review", type: "started" },
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
      },
    });

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-closed-done",
      issueKey: "USE-108",
      branchName: "use-108-analysis",
      prNumber: 193,
      prState: "open",
      prHeadSha: "closed-done-sha-1",
      prAuthorLogin: "patchrelay[bot]",
      prReviewState: "commented",
      prCheckStatus: "success",
      lastBlockingReviewHeadSha: "closed-done-sha-1",
      ciSummaryJson: JSON.stringify({ total: 1, completed: 1, passed: 1, failed: 0, pending: 0, overall: "success" }),
      ciLastUpdatedAt: "2026-04-10T09:00:00.000Z",
      workflowOutcome: "completed",
      currentLinearState: "Done",
      currentLinearStateType: "completed",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "pull_request",
      rawBody: buildTerminalPrPayload({
        action: "closed",
        branch: "use-108-analysis",
        headSha: "closed-done-sha-1",
        prNumber: 193,
        merged: false,
        prAuthorLogin: "patchrelay[bot]",
      }),
    });

    const issue = db.getIssue("usertold", "issue-closed-done");
    assertIssuePhase(issue, "done");
    assert.equal(issue?.currentLinearState, "Done");
    assert.equal(issue?.currentLinearStateType, "completed");
    assert.equal(issue?.prState, "closed");
    assert.equal(issue?.prReviewState, undefined);
    assert.equal(issue?.prCheckStatus, undefined);
    assert.equal(issue?.lastBlockingReviewHeadSha, undefined);
    assert.equal(issue?.ciSummaryJson, undefined);
    assert.equal(issue?.ciLastUpdatedAt, undefined);
    assert.deepEqual(setIssueStateCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("closed non-merged PR on unfinished work re-delegates implementation immediately", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-runtime-closed-redelegate-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-closed-redelegate",
      issueKey: "USE-109",
      branchName: "use-109-redelegate",
      prNumber: 194,
      prState: "open",
      prHeadSha: "closed-redelegate-sha-1",
      prAuthorLogin: "patchrelay[bot]",
      prReviewState: "commented",
      prCheckStatus: "success",
      lastBlockingReviewHeadSha: "closed-redelegate-sha-1",
      ciSummaryJson: JSON.stringify({ total: 1, completed: 1, passed: 1, failed: 0, pending: 0, overall: "success" }),
      ciLastUpdatedAt: "2026-04-10T09:05:00.000Z",
      workflowOutcome: undefined,
      currentLinearState: "Implementing",
      currentLinearStateType: "started",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "pull_request",
      rawBody: buildTerminalPrPayload({
        action: "closed",
        branch: "use-109-redelegate",
        headSha: "closed-redelegate-sha-1",
        prNumber: 194,
        merged: false,
        prAuthorLogin: "patchrelay[bot]",
      }),
    });

    const issue = db.getIssue("usertold", "issue-closed-redelegate");
    const workflowTask = resolveRuntimeTask(db, "usertold", "issue-closed-redelegate");
    assertIssuePhase(issue, "delegated");
    assert.equal(issue?.prState, "closed");
    assert.equal(issue?.prReviewState, undefined);
    assert.equal(issue?.prCheckStatus, undefined);
    assert.equal(issue?.lastBlockingReviewHeadSha, undefined);
    assert.equal(issue?.ciSummaryJson, undefined);
    assert.equal(issue?.ciLastUpdatedAt, undefined);
    assert.equal(workflowTask?.runType, "implementation");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-closed-redelegate" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("green gate-check completion does not queue new PatchRelay work", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-runtime-green-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-green",
      issueKey: "USE-11",
      branchName: "feat-green",
      prNumber: 11,
      prState: "open",
      workflowOutcome: undefined,
    });

    await handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildSuccessfulCheckRunPayload({
        branch: "feat-green",
        headSha: "sha-green",
        prNumber: 11,
      }),
    });

    const issue = db.getIssue("usertold", "issue-green");
    assert.equal(issue?.prCheckStatus, "success");
    assert.equal(issue?.activeRunId, undefined);
    assert.deepEqual(enqueueCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("non-gate successful checks do not mark PR checks green early", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-runtime-non-gate-green-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-non-gate-green",
      issueKey: "USE-11B",
      branchName: "feat-non-gate-green",
      prNumber: 112,
      prState: "open",
      workflowOutcome: undefined,
      prCheckStatus: "pending",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildSuccessfulCheckRunPayload({
        branch: "feat-non-gate-green",
        headSha: "sha-non-gate-green",
        prNumber: 112,
        checkName: "Static checks",
      }),
    });

    const issue = db.getIssue("usertold", "issue-non-gate-green");
    assert.equal(issue?.prCheckStatus, "pending");
    assert.equal(issue?.activeRunId, undefined);
    assert.deepEqual(enqueueCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("in-progress gate checks on the current head reset stored green status back to pending", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-runtime-pending-gate-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-pending-gate",
      issueKey: "USE-11C",
      branchName: "feat-pending-gate",
      prNumber: 113,
      prState: "open",
      prHeadSha: "sha-pending-gate",
      workflowOutcome: undefined,
      prCheckStatus: "success",
      lastGitHubCiSnapshotHeadSha: "sha-pending-gate",
      lastGitHubCiSnapshotGateCheckName: "Tests",
      lastGitHubCiSnapshotGateCheckStatus: "success",
      lastGitHubCiSnapshotJson: JSON.stringify({ headSha: "sha-pending-gate", gateCheckName: "Tests", gateCheckStatus: "success" }),
      lastGitHubCiSnapshotSettledAt: "2026-04-10T09:00:00.000Z",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildPendingCheckRunPayload({
        branch: "feat-pending-gate",
        headSha: "sha-pending-gate",
        prNumber: 113,
      }),
    });

    const issue = db.getIssue("usertold", "issue-pending-gate");
    assert.equal(issue?.prCheckStatus, "pending");
    assert.equal(issue?.lastGitHubCiSnapshotGateCheckStatus, "pending");
    assert.equal(issue?.lastGitHubCiSnapshotSettledAt, undefined);
    assert.deepEqual(enqueueCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("pull request label events are inert for PatchRelay queue scheduling", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-runtime-queue-label-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-queue-label",
      issueKey: "USE-11A",
      branchName: "feat-queue-label",
      prNumber: 111,
      prState: "open",
      workflowOutcome: undefined,
      prReviewState: "approved",
      prCheckStatus: "success",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "pull_request",
      rawBody: buildLabeledPrPayload({
        branch: "feat-queue-label",
        headSha: "sha-queue-label",
        prNumber: 111,
        labels: ["queue"],
      }),
    });

    assert.deepEqual(enqueueCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("ready_for_review pull request events are inert for PatchRelay start rules", () => {
  const payload = {
    action: "ready_for_review",
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: 12,
      html_url: "https://github.com/owner/repo/pull/12",
      state: "open",
      merged: false,
      head: { ref: "feat-ready", sha: "sha-ready" },
      base: { ref: "main" },
    },
  } as GitHubWebhookPayload;

  const normalized = normalizeGitHubWebhook({
    eventType: "pull_request",
    payload,
  });

  assert.equal(normalized, undefined);
});

test("requested changes on a delegated external PR queue review_fix", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-runtime-external-review-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(baseDir, {
      fetchImpl: async (input) => {
        if (String(input).includes("/reviews/901/comments")) {
          return createJsonResponse([]);
        }
        return createJsonResponse({}, 201);
      },
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-external-review",
      issueKey: "USE-12",
      branchName: "feat-nonowned",
      prNumber: 12,
      prState: "open",
      prAuthorLogin: "human-dev",
      workflowOutcome: undefined,
    });

    await handler.processGitHubWebhookEvent({
      eventType: "pull_request_review",
      rawBody: buildChangesRequestedReviewPayload({
        branch: "feat-nonowned",
        headSha: "sha-nonowned",
        prNumber: 12,
        prAuthorLogin: "human-dev",
      }),
    });

    const issue = db.getIssue("usertold", "issue-external-review");
    const workflowTask = resolveRuntimeTask(db, "usertold", "issue-external-review");
    assert.equal(issue?.prReviewState, "changes_requested");
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-external-review"), undefined);
    assert.equal(workflowTask?.runType, "review_fix");
    assert.equal(workflowTask?.workflowReason, "run:review_fix");
    assert.equal(workflowTask?.context?.reviewId, 901);
    assert.equal(workflowTask?.context?.reviewerName, "reviewbot");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-external-review" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("requested changes on a PatchRelay-owned PR queue review_fix", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-runtime-owned-review-"));
  const previousGitHubToken = process.env.GITHUB_TOKEN;
  try {
    process.env.GITHUB_TOKEN = "test-github-token";
    const fetchCalls: string[] = [];
    const { db, enqueueCalls, handler } = createHandler(baseDir, {
      fetchImpl: async (input) => {
        fetchCalls.push(String(input));
        return createJsonResponse([
          {
            id: 71,
            body: "Use the saved review context, not a fake leader.",
            path: "src/frontend/app/sessionSchema.ts",
            line: 1526,
            side: "RIGHT",
            commit_id: "sha-owned",
            html_url: "https://github.com/owner/repo/pull/13#discussion_r71",
            user: { login: "review-quill[bot]" },
          },
        ]);
      },
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-owned-review",
      issueKey: "USE-13",
      branchName: "feat-owned",
      prNumber: 13,
      prState: "open",
      prAuthorLogin: "patchrelay[bot]",
      workflowOutcome: undefined,
    });

    await handler.processGitHubWebhookEvent({
      eventType: "pull_request_review",
      rawBody: buildChangesRequestedReviewPayload({
        branch: "feat-owned",
        headSha: "sha-owned",
        prNumber: 13,
        prAuthorLogin: "patchrelay[bot]",
      }),
    });

    const issue = db.getIssue("usertold", "issue-owned-review");
    const workflowTask = resolveRuntimeTask(db, "usertold", "issue-owned-review");
    assert.equal(issue?.lastBlockingReviewHeadSha, "sha-owned");
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-owned-review"), undefined);
    assert.equal(workflowTask?.runType, "review_fix");
    assert.equal(workflowTask?.workflowReason, "run:review_fix");
    assert.equal(workflowTask?.context?.reviewId, 901);
    assert.equal(workflowTask?.context?.reviewCommitId, "sha-owned");
    assert.equal(workflowTask?.context?.reviewerName, "reviewbot");
    assert.equal(workflowTask?.context?.reviewUrl, "https://github.com/owner/repo/pull/13#pullrequestreview-901");
    assert.deepEqual(workflowTask?.context?.reviewComments, [
      {
        id: 71,
        body: "Use the saved review context, not a fake leader.",
        path: "src/frontend/app/sessionSchema.ts",
        line: 1526,
        side: "RIGHT",
        commitId: "sha-owned",
        url: "https://github.com/owner/repo/pull/13#discussion_r71",
        authorLogin: "review-quill[bot]",
      },
    ]);
    assert.deepEqual(fetchCalls, [
      "https://api.github.com/repos/owner/repo/pulls/13/reviews/901/comments?per_page=100",
    ]);
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-owned-review" }]);
  } finally {
    if (previousGitHubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previousGitHubToken;
    }
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("requested changes during an active run are persisted for replay without immediate enqueue", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-runtime-active-review-"));
  const previousGitHubToken = process.env.GITHUB_TOKEN;
  try {
    process.env.GITHUB_TOKEN = "test-github-token";
    const { db, enqueueCalls, handler } = createHandler(baseDir, {
      fetchImpl: async () => createJsonResponse([]),
    });
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-active-review",
      issueKey: "USE-13A",
      branchName: "feat-active-review",
      prNumber: 131,
      prState: "open",
      prAuthorLogin: "patchrelay[bot]",
      workflowOutcome: undefined,
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });

    await handler.processGitHubWebhookEvent({
      eventType: "pull_request_review",
      rawBody: buildChangesRequestedReviewPayload({
        branch: "feat-active-review",
        headSha: "sha-active-review",
        prNumber: 131,
        prAuthorLogin: "patchrelay[bot]",
      }),
    });

    const updatedIssue = db.getIssue("usertold", "issue-active-review");
    assertIssuePhase(updatedIssue, "implementing");
    assert.equal(updatedIssue?.prReviewState, "changes_requested");
    assert.equal(updatedIssue?.activeRunId, run.id);
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-active-review"), undefined);
    assert.equal(resolveRuntimeTask(db, "usertold", "issue-active-review")?.runType, undefined);
    assert.equal(
      db.workflowObservations.listObservations("usertold", "issue-active-review")
        .some((entry) => entry.type === "github.review_changes_requested"),
      true,
    );
    assert.deepEqual(enqueueCalls, []);
  } finally {
    if (previousGitHubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previousGitHubToken;
    }
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("a follow-up requested-changes review on an idle issue still re-enqueues even when a workflowTask is already pending", async () => {
  // Regression: previously the second review's `hadPendingWorkflowTask=true` short-circuit
  // skipped enqueueIssue, assuming the first review's enqueue was still in flight.
  // If that first enqueue had silently dropped (lease race, lost in-memory queue),
  // the issue stayed orphaned with stacked unprocessed events until an external nudge.
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-runtime-stacked-review-"));
  const previousGitHubToken = process.env.GITHUB_TOKEN;
  try {
    process.env.GITHUB_TOKEN = "test-github-token";
    const { db, enqueueCalls, handler } = createHandler(baseDir, {
      fetchImpl: async () => createJsonResponse([]),
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-stacked-review",
      issueKey: "USE-STACKED",
      branchName: "feat-stacked",
      prNumber: 141,
      prState: "open",
      prAuthorLogin: "patchrelay[bot]",
      workflowOutcome: undefined,
    });

    await handler.processGitHubWebhookEvent({
      eventType: "pull_request_review",
      rawBody: buildChangesRequestedReviewPayload({
        branch: "feat-stacked",
        headSha: "sha-first-head",
        prNumber: 141,
        prAuthorLogin: "patchrelay[bot]",
        reviewId: 911,
      }),
    });

    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-stacked-review" }]);
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-stacked-review"), undefined);
    enqueueCalls.length = 0;

    // Second review on a new head while the first review's workflowTask is still pending.
    await handler.processGitHubWebhookEvent({
      eventType: "pull_request_review",
      rawBody: buildChangesRequestedReviewPayload({
        branch: "feat-stacked",
        headSha: "sha-second-head",
        prNumber: 141,
        prAuthorLogin: "patchrelay[bot]",
        reviewId: 912,
      }),
    });

    assert.deepEqual(
      enqueueCalls,
      [{ projectId: "usertold", issueId: "issue-stacked-review" }],
      "second review must re-enqueue even though a workflowTask is already pending",
    );
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-stacked-review"), undefined);
    assert.equal(resolveRuntimeTask(db, "usertold", "issue-stacked-review")?.context?.reviewId, 912);
  } finally {
    if (previousGitHubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previousGitHubToken;
    }
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("push after requested changes does not auto request re-review", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-runtime-rereview-"));
  try {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { db, enqueueCalls, handler } = createHandler(baseDir, {
      fetchImpl: async (input, init) => {
        fetchCalls.push({ url: String(input), init });
        if (String(input).includes("/reviews/901/comments")) {
          return createJsonResponse([]);
        }
        return createJsonResponse({}, 201);
      },
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-rereview",
      issueKey: "USE-26",
      branchName: "feat-rereview",
      prNumber: 26,
      prState: "open",
      prAuthorLogin: "patchrelay[bot]",
      workflowOutcome: undefined,
      prReviewState: "changes_requested",
      prCheckStatus: "success",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "pull_request_review",
      rawBody: buildChangesRequestedReviewPayload({
        branch: "feat-rereview",
        headSha: "sha-review",
        prNumber: 26,
        prAuthorLogin: "patchrelay[bot]",
      }),
    });
    fetchCalls.length = 0;
    enqueueCalls.length = 0;

    await handler.processGitHubWebhookEvent({
      eventType: "pull_request",
      rawBody: buildSynchronizePrPayload({
        branch: "feat-rereview",
        headSha: "sha-push",
        prNumber: 26,
        prAuthorLogin: "patchrelay[bot]",
      }),
    });

    const issue = db.getIssue("usertold", "issue-rereview");
    assert.equal(issue?.prCheckStatus, "pending");
    assert.deepEqual(enqueueCalls, []);
    assert.deepEqual(fetchCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("undelegated issue tracks requested-changes state without queuing repair work", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-runtime-undelegated-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(baseDir, {
      fetchImpl: async (input) => {
        if (String(input).includes("/reviews/901/comments")) {
          return createJsonResponse([]);
        }
        return createJsonResponse({}, 201);
      },
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-undelegated-review",
      issueKey: "USE-44",
      delegatedToPatchRelay: false,
      branchName: "feat-undelegated",
      prNumber: 44,
      prState: "open",
      prAuthorLogin: "patchrelay[bot]",
      workflowOutcome: undefined,
    });

    await handler.processGitHubWebhookEvent({
      eventType: "pull_request_review",
      rawBody: buildChangesRequestedReviewPayload({
        branch: "feat-undelegated",
        headSha: "sha-undelegated",
        prNumber: 44,
        prAuthorLogin: "patchrelay[bot]",
      }),
    });

    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-undelegated-review");
    const issue = db.getIssue("usertold", "issue-undelegated-review");
    assert.equal(workflowTask, undefined);
    assertIssuePhase(issue, "paused");
    assert.equal(issue?.delegatedToPatchRelay, false);
    assert.deepEqual(enqueueCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("undelegated issue links an external PR by issue key and tracks it without queuing work", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-runtime-external-link-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-external-link",
      issueKey: "USE-60",
      delegatedToPatchRelay: false,
      branchName: "use/60-old-branch",
      inputRequestKind: "completion_check_question",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "pull_request",
      rawBody: buildOpenedPrPayload({
        branch: "handoff/use-60-fix",
        headSha: "sha-external-open",
        prNumber: 60,
        prAuthorLogin: "human-dev",
        prTitle: "USE-60 tighten mobile input sizing",
        prBody: "Implements USE-60 from an external branch.",
      }),
    });

    const issue = db.getIssue("usertold", "issue-external-link");
    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-external-link");
    assert.equal(issue?.prNumber, 60);
    assert.equal(issue?.prState, "open");
    assert.equal(issue?.prAuthorLogin, "human-dev");
    assert.equal(issue?.branchName, "handoff/use-60-fix");
    assertIssuePhase(issue, "awaiting_input");
    assert.equal(issue?.delegatedToPatchRelay, false);
    assert.equal(workflowTask, undefined);
    assert.deepEqual(enqueueCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("late PatchRelay PR from a released implementation run is auto-closed instead of being linked", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-runtime-late-pr-close-"));
  const oldToken = process.env.GH_TOKEN;
  try {
    process.env.GH_TOKEN = "test-token";
    const fetchCalls: Array<{ url: string; method: string; body?: string }> = [];
    const { db, enqueueCalls, handler } = createHandler(baseDir, {
      fetchImpl: async (input, init) => {
        fetchCalls.push({
          url: String(input),
          method: String(init?.method ?? "GET"),
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return createJsonResponse({ state: "closed" });
      },
    });
    const issueRecord = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-late-pr-close",
      issueKey: "USE-62",
      delegatedToPatchRelay: true,
      branchName: "use/62-setup",
      workflowOutcome: undefined,
    });
    db.runs.finishRun(
      db.runs.createRun({
        issueId: issueRecord.id,
        projectId: "usertold",
        linearIssueId: "issue-late-pr-close",
        runType: "implementation",
        promptText: "do the work",
      }).id,
      { status: "released", failureReason: "Issue became blocked during implementation" },
    );

    await handler.processGitHubWebhookEvent({
      eventType: "pull_request",
      rawBody: buildOpenedPrPayload({
        branch: "use/62-setup",
        headSha: "sha-late-open",
        prNumber: 62,
        prAuthorLogin: "patchrelay[bot]",
        prTitle: "USE-62 late PR",
      }),
    });

    const issue = db.getIssue("usertold", "issue-late-pr-close");
    assert.equal(issue?.prNumber, undefined);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]?.method, "PATCH");
    assert.match(fetchCalls[0]?.url ?? "", /\/repos\/owner\/repo\/pulls\/62$/);
    assert.equal(fetchCalls[0]?.body, JSON.stringify({ state: "closed" }));
    assert.deepEqual(enqueueCalls, []);
  } finally {
    if (oldToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = oldToken;
    }
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("delegated issue can repair failing CI on an externally linked PR", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-runtime-external-ci-repair-"));
  try {
    const failureContextResolver: GitHubFailureContextResolver = {
      resolve: async () => ({
        source: "branch_ci",
        failureHeadSha: "sha-external-open",
        failureSignature: "branch_ci::sha-external-open::Tests",
        checkName: "Tests",
        summary: "Tests failed",
      }),
    };
    const ciSnapshotResolver: GitHubCiSnapshotResolver = {
      resolve: async () => ({
        headSha: "sha-external-open",
        gateCheckName: "Tests",
        gateCheckStatus: "failure",
        settledAt: "2026-04-10T08:30:00.000Z",
        checks: [
          { name: "Tests", status: "failure", conclusion: "failure" },
        ],
        failedChecks: [
          { name: "Tests", status: "failure", conclusion: "failure" },
        ],
      }),
    };
    const { db, enqueueCalls, handler } = createHandler(baseDir, {
      failureContextResolver,
      ciSnapshotResolver,
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-external-ci-repair",
      issueKey: "USE-61",
      delegatedToPatchRelay: false,
      branchName: "use/61-old-branch",
      inputRequestKind: "completion_check_question",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "pull_request",
      rawBody: buildOpenedPrPayload({
        branch: "handoff/use-61-fix",
        headSha: "sha-external-open",
        prNumber: 61,
        prAuthorLogin: "human-dev",
        prTitle: "USE-61 keep external PR linked",
        prBody: "External branch for USE-61.",
      }),
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-external-ci-repair",
      delegatedToPatchRelay: true,
      workflowOutcome: undefined,
    });

    await handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildFailedCheckRunPayload({
        branch: "handoff/use-61-fix",
        headSha: "sha-external-open",
        prNumber: 61,
      }),
    });

    const issue = db.getIssue("usertold", "issue-external-ci-repair");
    const workflowTask = resolveRuntimeTask(db, "usertold", "issue-external-ci-repair");
    assert.equal(issue?.lastGitHubFailureSource, "branch_ci");
    assert.equal(issue?.branchName, "handoff/use-61-fix");
    assert.equal(issue?.prHeadSha, "sha-external-open");
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-external-ci-repair"), undefined);
    assert.equal(workflowTask?.runType, "ci_repair");
    assert.equal(workflowTask?.workflowReason, "run:ci_repair");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-external-ci-repair" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("GitHub PR comments on idle PatchRelay-owned PRs queue follow-up session work", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-runtime-pr-comment-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-pr-comment",
      issueKey: "USE-14",
      branchName: "feat-comment",
      prNumber: 14,
      prState: "open",
      prAuthorLogin: "patchrelay[bot]",
      workflowOutcome: undefined,
    });

    await handler.processGitHubWebhookEvent({
      eventType: "issue_comment",
      rawBody: buildPrCommentPayload({
        prNumber: 14,
        body: "Please tighten the naming here.",
        author: "maintainer",
      }),
    });

    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-pr-comment");
    assert.equal(workflowTask?.runType, "implementation");
    assert.equal(Array.isArray(workflowTask?.context.followUps), true);
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-pr-comment" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("merged PatchRelay-owned PRs release active runs and do not queue new work", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-runtime-merged-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(baseDir);
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-merged-active",
      issueKey: "USE-15",
      branchName: "feat-merged",
      prNumber: 15,
      prState: "open",
      prAuthorLogin: "patchrelay[bot]",
      workflowOutcome: undefined,
      threadId: "thread-merged",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: "usertold",
      linearIssueId: "issue-merged-active",
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-merged", turnId: "turn-merged" });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-merged-active",
      activeRunId: run.id,
    });

    await handler.processGitHubWebhookEvent({
      eventType: "pull_request",
      rawBody: buildTerminalPrPayload({
        action: "closed",
        branch: "feat-merged",
        headSha: "sha-merged",
        prNumber: 15,
        merged: true,
      }),
    });

    const updatedIssue = db.getIssue("usertold", "issue-merged-active");
    const updatedRun = db.runs.getRunById(run.id);
    assertIssuePhase(updatedIssue, "done");
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedRun?.status, "released");
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-merged-active"), undefined);
    assert.deepEqual(enqueueCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
