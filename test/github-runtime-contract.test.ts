import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { GitHubWebhookHandler } from "../src/github-webhook-handler.ts";
import { normalizeGitHubWebhook } from "../src/github-webhooks.ts";
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
  options?: {
    linearProvider?: { forProject(projectId: string): Promise<LinearClient | undefined> };
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
    undefined,
    undefined,
    options?.fetchImpl,
  );
  return { db, enqueueCalls, handler };
}

function buildApprovedReviewPayload(params: {
  branch: string;
  headSha: string;
  prNumber: number;
  prAuthorLogin?: string;
}): string {
  return JSON.stringify({
    action: "submitted",
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
}): string {
  return JSON.stringify({
    action: "submitted",
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: params.prNumber,
      html_url: `https://github.com/owner/repo/pull/${params.prNumber}`,
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

function createJsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
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
      factoryState: "pr_open",
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
    assert.equal(issue?.pendingRunType, undefined);
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
      factoryState: "awaiting_queue",
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
    assert.equal(issue?.factoryState, "done");
    assert.equal(issue?.currentLinearState, "Done");
    assert.equal(issue?.currentLinearStateType, "completed");
    assert.deepEqual(setIssueStateCalls, ["Done"]);
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
      factoryState: "pr_open",
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
    assert.equal(issue?.pendingRunType, undefined);
    assert.equal(issue?.activeRunId, undefined);
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
      factoryState: "awaiting_queue",
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

    const issue = db.getIssue("usertold", "issue-queue-label");
    assert.equal(issue?.pendingRunType, undefined);
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

test("requested changes on a non-PatchRelay-owned PR do not queue follow-up work", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-runtime-nonowned-review-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-nonowned-review",
      issueKey: "USE-12",
      branchName: "feat-nonowned",
      prNumber: 12,
      prState: "open",
      prAuthorLogin: "human-dev",
      factoryState: "pr_open",
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

    const issue = db.getIssue("usertold", "issue-nonowned-review");
    assert.equal(issue?.prReviewState, "changes_requested");
    assert.equal(issue?.pendingRunType, undefined);
    assert.deepEqual(enqueueCalls, []);
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
      factoryState: "pr_open",
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
    const wake = db.issueSessions.peekIssueSessionWake("usertold", "issue-owned-review");
    assert.equal(issue?.pendingRunType, undefined);
    assert.equal(issue?.lastBlockingReviewHeadSha, "sha-owned");
    assert.equal(wake?.runType, "review_fix");
    assert.equal(wake?.wakeReason, "review_changes_requested");
    assert.equal(wake?.context.reviewId, 901);
    assert.equal(wake?.context.reviewCommitId, "sha-owned");
    assert.equal(wake?.context.reviewerName, "reviewbot");
    assert.equal(wake?.context.reviewUrl, "https://github.com/owner/repo/pull/13#pullrequestreview-901");
    assert.deepEqual(wake?.context.reviewComments, [
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
      factoryState: "changes_requested",
      prReviewState: "changes_requested",
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

    assert.deepEqual(enqueueCalls, []);
    assert.deepEqual(fetchCalls, []);
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
      factoryState: "pr_open",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "issue_comment",
      rawBody: buildPrCommentPayload({
        prNumber: 14,
        body: "Please tighten the naming here.",
        author: "maintainer",
      }),
    });

    const wake = db.issueSessions.peekIssueSessionWake("usertold", "issue-pr-comment");
    assert.equal(wake?.runType, "implementation");
    assert.equal(Array.isArray(wake?.context.followUps), true);
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
      factoryState: "implementing",
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
    assert.equal(updatedIssue?.factoryState, "done");
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedRun?.status, "released");
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-merged-active"), undefined);
    assert.deepEqual(enqueueCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
