import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { GitHubWebhookHandler } from "../src/github-webhook-handler.ts";
import type { GitHubCiSnapshotResolver, GitHubFailureContextResolver } from "../src/github-failure-context.ts";
import type { AppConfig } from "../src/types.ts";

function createConfig(baseDir: string, options?: { gateChecks?: string[] }): AppConfig {
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
        gateChecks: options?.gateChecks ?? ["Tests"],
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
  options?: { gateChecks?: string[] },
) {
  const config = createConfig(baseDir, options);
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();
  const enqueueCalls: Array<{ projectId: string; issueId: string }> = [];
  const handler = new GitHubWebhookHandler(
    config,
    db,
    { forProject: async () => undefined } as never,
    (projectId, issueId) => {
      enqueueCalls.push({ projectId, issueId });
    },
    pino({ enabled: false }),
    { steerTurn: async () => undefined } as never,
    undefined,
    failureContextResolver,
    ciSnapshotResolver,
  );
  return { config, db, enqueueCalls, handler };
}

function buildCheckRunPayload(params: {
  branch: string;
  headSha: string;
  prNumber: number;
  checkName: string;
  conclusion: "failure" | "success";
  htmlUrl?: string;
  detailsUrl?: string;
  outputTitle?: string;
  outputSummary?: string;
  outputText?: string;
}): Buffer {
  return Buffer.from(JSON.stringify({
    action: "completed",
    repository: { full_name: "owner/repo" },
    check_run: {
      conclusion: params.conclusion,
      name: params.checkName,
      html_url: params.htmlUrl ?? `https://github.com/owner/repo/actions/runs/${params.prNumber}`,
      details_url: params.detailsUrl ?? `https://queue.example.com/queue/incidents/incident-${params.prNumber}`,
      head_sha: params.headSha,
      output: {
        title: params.outputTitle ?? "Queue eviction: rebase conflict",
        summary: params.outputSummary ?? `PR #${params.prNumber} was evicted from the merge queue.`,
        text: params.outputText,
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
  }), "utf8");
}

test("queue eviction check_run queues queue_repair with explicit provenance", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-queue-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-1",
      branchName: "feat-queue",
      prNumber: 42,
      prState: "open",
      factoryState: "awaiting_queue",
    });
    await handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildCheckRunPayload({
        branch: "feat-queue",
        headSha: "sha-42",
        prNumber: 42,
        checkName: "merge-steward/queue",
        conclusion: "failure",
        outputText: JSON.stringify({
          incidentId: "incident-42",
          incidentUrl: "https://queue.example.com/queue/incidents/incident-42",
          version: 1,
          failureClass: "integration_conflict",
          baseSha: "base-123",
          prHeadSha: "sha-42",
          queuePosition: 1,
          baseBranch: "main",
          branch: "feat-queue",
          issueKey: "USE-1",
          conflictFiles: ["src/conflicted.ts"],
          failedChecks: [{ name: "test", conclusion: "failure", url: "https://github.com/owner/repo/checks/1" }],
          retryHistory: [{ at: "2026-03-31T00:00:00.000Z", baseSha: "base-122", outcome: "ci_failed_retry" }],
        }),
      }).toString("utf8"),
    });

    const issue = db.getIssue("usertold", "issue-1");
    const wake = db.peekIssueSessionWake("usertold", "issue-1");
    assert.equal(issue?.branchOwner, "patchrelay");
    assert.equal(issue?.factoryState, "repairing_queue");
    assert.equal(wake?.runType, "queue_repair");
    const pending = wake?.context ?? {};
    assert.equal(pending.failureReason, "queue_eviction");
    assert.equal(pending.checkName, "merge-steward/queue");
    assert.equal(pending.checkUrl, "https://github.com/owner/repo/actions/runs/42");
    assert.equal(pending.failureHeadSha, "sha-42");
    assert.equal(pending.failureSignature, "queue_eviction::sha-42::merge-steward/queue");
    assert.equal(pending.incidentId, "incident-42");
    assert.equal(pending.incidentUrl, "https://queue.example.com/queue/incidents/incident-42");
    assert.equal(pending.incidentTitle, "Queue eviction: rebase conflict");
    assert.equal(pending.incidentSummary, "PR #42 was evicted from the merge queue.");
    assert.deepEqual(pending.incidentContext, {
      version: 1,
      failureClass: "integration_conflict",
      baseSha: "base-123",
      prHeadSha: "sha-42",
      queuePosition: 1,
      baseBranch: "main",
      branch: "feat-queue",
      issueKey: "USE-1",
      conflictFiles: ["src/conflicted.ts"],
      failedChecks: [{ name: "test", conclusion: "failure", url: "https://github.com/owner/repo/checks/1" }],
      retryHistory: [{ at: "2026-03-31T00:00:00.000Z", baseSha: "base-122", outcome: "ci_failed_retry" }],
    });
    assert.equal(issue?.lastQueueIncidentJson !== undefined, true);
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-1" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("stale queue eviction webhooks do not resurrect terminal issues", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-queue-stale-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-2",
      issueKey: "USE-2",
      branchName: "feat-stale",
      prNumber: 7,
      prState: "open",
      factoryState: "done",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildCheckRunPayload({
        branch: "feat-stale",
        headSha: "sha-7",
        prNumber: 7,
        checkName: "merge-steward/queue",
        conclusion: "failure",
      }).toString("utf8"),
    });

    const issue = db.getIssue("usertold", "issue-2");
    assert.equal(issue?.factoryState, "done");
    assert.equal(issue?.pendingRunType, undefined);
    assert.deepEqual(enqueueCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("default gate fallback recognizes verify and enqueues CI repair", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-verify-gate-"));
  try {
    const failureContextResolver: GitHubFailureContextResolver = {
      resolve: async () => ({
        source: "branch_ci",
        failureHeadSha: "sha-verify",
        failureSignature: "branch_ci::sha-verify::verify",
        checkName: "verify",
        summary: "verify failed",
      }),
    };
    const ciSnapshotResolver: GitHubCiSnapshotResolver = {
      resolve: async () => ({
        headSha: "sha-verify",
        gateCheckName: "verify",
        gateCheckStatus: "failure",
        settledAt: "2026-04-06T00:17:44.000Z",
        checks: [
          { name: "verify", status: "failure", conclusion: "failure" },
          { name: "deploy_stage", status: "pending", conclusion: null },
        ],
        failedChecks: [
          { name: "verify", status: "failure", conclusion: "failure" },
        ],
      }),
    };
    const { db, enqueueCalls, handler } = createHandler(
      baseDir,
      failureContextResolver,
      ciSnapshotResolver,
      { gateChecks: [] },
    );
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-verify",
      issueKey: "USE-VERIFY",
      branchName: "feat-verify",
      prNumber: 44,
      prState: "open",
      prAuthorLogin: "patchrelay[bot]",
      factoryState: "pr_open",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildCheckRunPayload({
        branch: "feat-verify",
        headSha: "sha-verify",
        prNumber: 44,
        checkName: "verify",
        conclusion: "failure",
        outputTitle: "verify failed",
        outputSummary: "Required verification failed.",
      }).toString("utf8"),
    });

    const wake = db.peekIssueSessionWake("usertold", "issue-verify");
    assert.equal(wake?.runType, "ci_repair");
    assert.equal(wake?.wakeReason, "settled_red_ci");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-verify" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("queue eviction falls back to minimal context when incident payload is malformed", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-queue-malformed-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-3",
      issueKey: "USE-3",
      branchName: "feat-malformed",
      prNumber: 43,
      prState: "open",
      factoryState: "awaiting_queue",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildCheckRunPayload({
        branch: "feat-malformed",
        headSha: "sha-43",
        prNumber: 43,
        checkName: "merge-steward/queue",
        conclusion: "failure",
        outputTitle: "Queue eviction: rebase conflict",
        outputSummary: "Malformed steward payload fallback",
        outputText: "{not-json",
      }).toString("utf8"),
    });

    const wake = db.peekIssueSessionWake("usertold", "issue-3");
    assert.equal(wake?.runType, "queue_repair");
    const pending = wake?.context ?? {};
    assert.equal(pending.failureReason, "queue_eviction");
    assert.equal(pending.checkName, "merge-steward/queue");
    assert.equal(pending.checkUrl, "https://github.com/owner/repo/actions/runs/43");
    assert.equal(pending.failureHeadSha, "sha-43");
    assert.equal(pending.incidentUrl, "https://queue.example.com/queue/incidents/incident-43");
    assert.equal(pending.incidentTitle, "Queue eviction: rebase conflict");
    assert.equal(pending.incidentSummary, "Malformed steward payload fallback");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-3" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("branch CI failures clear stale queue incident context", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-queue-cleared-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(
      baseDir,
      {
        resolve: async () => ({
          source: "branch_ci",
          repoFullName: "owner/repo",
          capturedAt: "2026-04-01T00:00:00.000Z",
          headSha: "sha-44",
          failureSignature: "branch_ci::sha-44::Checks::Run tests",
          checkName: "Checks",
          checkUrl: "https://github.com/owner/repo/actions/runs/44",
          jobName: "Checks",
          stepName: "Run tests",
          summary: "Tests failed",
        }),
      },
      {
        resolve: async () => ({
          headSha: "sha-44",
          gateCheckName: "Tests",
          gateCheckStatus: "failure",
          failedChecks: [
            { name: "Checks", status: "failure", conclusion: "failure", detailsUrl: "https://github.com/owner/repo/actions/runs/44", summary: "Tests failed" },
            { name: "Tests", status: "failure", conclusion: "failure" },
          ],
          checks: [
            { name: "Checks", status: "failure", conclusion: "failure", detailsUrl: "https://github.com/owner/repo/actions/runs/44", summary: "Tests failed" },
            { name: "Tests", status: "failure", conclusion: "failure" },
          ],
          settledAt: "2026-04-01T00:00:05.000Z",
          capturedAt: "2026-04-01T00:00:05.000Z",
        }),
      },
    );
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-4",
      issueKey: "USE-4",
      branchName: "feat-branch-fail",
      prNumber: 44,
      prState: "open",
      factoryState: "awaiting_queue",
      lastGitHubFailureSource: "queue_eviction",
      lastGitHubFailureCheckName: "merge-steward/queue",
      lastGitHubFailureCheckUrl: "https://github.com/owner/repo/actions/runs/44",
      lastQueueIncidentJson: JSON.stringify({
        failureReason: "queue_eviction",
        checkName: "merge-steward/queue",
        incidentId: "incident-44",
        incidentUrl: "https://queue.example.com/queue/incidents/incident-44",
      }),
    });
    await handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildCheckRunPayload({
        branch: "feat-branch-fail",
        headSha: "sha-44",
        prNumber: 44,
        checkName: "Tests",
        conclusion: "failure",
      }).toString("utf8"),
    });

    const issue = db.getIssue("usertold", "issue-4");
    const wake = db.peekIssueSessionWake("usertold", "issue-4");
    assert.equal(issue?.branchOwner, "patchrelay");
    assert.equal(wake?.runType, "ci_repair");
    assert.equal(issue?.lastGitHubFailureSource, "branch_ci");
    assert.equal(issue?.lastQueueIncidentJson, undefined);
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-4" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("branch CI failures persist enriched Actions context in pending repair prompt", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-ci-context-"));
  try {
    let resolvedCheckName: string | undefined;
    const { db, enqueueCalls, handler } = createHandler(baseDir, {
      resolve: async ({ event }) => {
        resolvedCheckName = event.checkName;
        return {
        source: "branch_ci",
        repoFullName: "owner/repo",
        capturedAt: "2026-04-01T00:00:00.000Z",
        headSha: "sha-45",
        failureSignature: "branch_ci::sha-45::Checks::npx tsgo --noEmit",
        checkName: "Checks",
        checkUrl: "https://github.com/owner/repo/actions/runs/45",
        jobName: "Checks",
        stepName: "Run npx tsgo --noEmit",
        summary: "Type generation failed",
        annotations: ["src/schema.ts: incompatible type"],
        };
      },
    }, {
      resolve: async () => ({
        headSha: "sha-45",
        gateCheckName: "Tests",
        gateCheckStatus: "failure",
        failedChecks: [
          {
            name: "Checks",
            status: "failure",
            conclusion: "failure",
            detailsUrl: "https://github.com/owner/repo/actions/runs/45",
            summary: "Type generation failed",
          },
          {
            name: "Tests",
            status: "failure",
            conclusion: "failure",
          },
        ],
        checks: [
          {
            name: "Checks",
            status: "failure",
            conclusion: "failure",
            detailsUrl: "https://github.com/owner/repo/actions/runs/45",
            summary: "Type generation failed",
          },
          {
            name: "Tests",
            status: "failure",
            conclusion: "failure",
          },
        ],
        settledAt: "2026-04-01T00:00:05.000Z",
        capturedAt: "2026-04-01T00:00:05.000Z",
      }),
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-5",
      issueKey: "USE-5",
      branchName: "feat-ci-context",
      prNumber: 45,
      prState: "open",
      factoryState: "pr_open",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildCheckRunPayload({
        branch: "feat-ci-context",
        headSha: "sha-45",
        prNumber: 45,
        checkName: "Tests",
        conclusion: "failure",
      }).toString("utf8"),
    });

    const issue = db.getIssue("usertold", "issue-5");
    const wake = db.peekIssueSessionWake("usertold", "issue-5");
    const pending = wake?.context ?? {};
    assert.equal(resolvedCheckName, "Checks");
    assert.equal(wake?.runType, "ci_repair");
    assert.equal(issue?.lastGitHubFailureSignature, "branch_ci::sha-45::Checks::npx tsgo --noEmit");
    assert.equal(issue?.lastGitHubFailureHeadSha, "sha-45");
    assert.equal(pending.failureHeadSha, "sha-45");
    assert.equal(pending.jobName, "Checks");
    assert.equal(pending.stepName, "Run npx tsgo --noEmit");
    assert.equal(pending.summary, "Type generation failed");
    assert.deepEqual(pending.annotations, ["src/schema.ts: incompatible type"]);
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-5" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("same failure signature and head sha are not re-enqueued after an attempted repair", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-ci-dedupe-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(baseDir, {
      resolve: async () => ({
        source: "branch_ci",
        repoFullName: "owner/repo",
        capturedAt: "2026-04-01T00:00:00.000Z",
        headSha: "sha-46",
        failureSignature: "branch_ci::sha-46::Checks::Run tests",
        checkName: "Checks",
        checkUrl: "https://github.com/owner/repo/actions/runs/46",
        jobName: "Checks",
        stepName: "Run tests",
        summary: "Tests failed",
      }),
    }, {
      resolve: async () => ({
        headSha: "sha-46",
        gateCheckName: "Tests",
        gateCheckStatus: "failure",
        failedChecks: [
          { name: "Checks", status: "failure", conclusion: "failure", detailsUrl: "https://github.com/owner/repo/actions/runs/46", summary: "Tests failed" },
          { name: "Tests", status: "failure", conclusion: "failure" },
        ],
        checks: [
          { name: "Checks", status: "failure", conclusion: "failure", detailsUrl: "https://github.com/owner/repo/actions/runs/46", summary: "Tests failed" },
          { name: "Tests", status: "failure", conclusion: "failure" },
        ],
        settledAt: "2026-04-01T00:00:05.000Z",
        capturedAt: "2026-04-01T00:00:05.000Z",
      }),
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-6",
      issueKey: "USE-6",
      branchName: "feat-ci-dedupe",
      prNumber: 46,
      prState: "open",
      factoryState: "repairing_ci",
      lastAttemptedFailureHeadSha: "sha-46",
      lastAttemptedFailureSignature: "branch_ci::sha-46::Checks::Run tests",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildCheckRunPayload({
        branch: "feat-ci-dedupe",
        headSha: "sha-46",
        prNumber: 46,
        checkName: "Tests",
        conclusion: "failure",
      }).toString("utf8"),
    });

    const issue = db.getIssue("usertold", "issue-6");
    assert.equal(issue?.pendingRunType, undefined);
    assert.deepEqual(enqueueCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("non-gate branch CI failures wait for the settled Tests gate before enqueuing repair", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-ci-settlement-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-7",
      issueKey: "USE-7",
      branchName: "feat-ci-settlement",
      prNumber: 47,
      prState: "open",
      factoryState: "pr_open",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildCheckRunPayload({
        branch: "feat-ci-settlement",
        headSha: "sha-47",
        prNumber: 47,
        checkName: "Checks",
        conclusion: "failure",
      }).toString("utf8"),
    });

    const issue = db.getIssue("usertold", "issue-7");
    assert.equal(issue?.pendingRunType, undefined);
    assert.deepEqual(enqueueCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("checks with similar names do not count as the Tests gate", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-ci-similar-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-8",
      issueKey: "USE-8",
      branchName: "feat-ci-similar",
      prNumber: 48,
      prState: "open",
      factoryState: "pr_open",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildCheckRunPayload({
        branch: "feat-ci-similar",
        headSha: "sha-48",
        prNumber: 48,
        checkName: "Build & UI Tests",
        conclusion: "failure",
      }).toString("utf8"),
    });

    const issue = db.getIssue("usertold", "issue-8");
    assert.equal(issue?.pendingRunType, undefined);
    assert.equal(issue?.lastGitHubCiSnapshotJson, undefined);
    assert.deepEqual(enqueueCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("gate failures wait when settled snapshot resolution is unavailable", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-ci-unavailable-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(baseDir, undefined, {
      resolve: async () => undefined,
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-9",
      issueKey: "USE-9",
      branchName: "feat-ci-unavailable",
      prNumber: 49,
      prState: "open",
      factoryState: "pr_open",
      lastGitHubCiSnapshotHeadSha: "sha-49",
      lastGitHubCiSnapshotGateCheckName: "Tests",
      lastGitHubCiSnapshotGateCheckStatus: "pending",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildCheckRunPayload({
        branch: "feat-ci-unavailable",
        headSha: "sha-49",
        prNumber: 49,
        checkName: "Tests",
        conclusion: "failure",
      }).toString("utf8"),
    });

    const issue = db.getIssue("usertold", "issue-9");
    assert.equal(issue?.pendingRunType, undefined);
    assert.equal(issue?.lastGitHubFailureSource, undefined);
    assert.equal(issue?.lastGitHubCiSnapshotHeadSha, "sha-49");
    assert.equal(issue?.lastGitHubCiSnapshotGateCheckStatus, "pending");
    assert.equal(issue?.lastGitHubCiSnapshotJson, undefined);
    assert.deepEqual(enqueueCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("stale passing gate events do not clear failure provenance for a newer head", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-ci-stale-pass-"));
  try {
    const { db, enqueueCalls, handler } = createHandler(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-10",
      issueKey: "USE-10",
      branchName: "feat-ci-stale-pass",
      prNumber: 50,
      prState: "open",
      factoryState: "repairing_ci",
      lastGitHubFailureSource: "branch_ci",
      lastGitHubFailureHeadSha: "sha-new",
      lastGitHubFailureSignature: "branch_ci::sha-new::Checks::Run tests",
      lastGitHubFailureCheckName: "Checks",
      lastGitHubCiSnapshotHeadSha: "sha-new",
      lastGitHubCiSnapshotGateCheckName: "Tests",
      lastGitHubCiSnapshotGateCheckStatus: "failure",
      lastGitHubCiSnapshotJson: JSON.stringify({
        headSha: "sha-new",
        gateCheckName: "Tests",
        gateCheckStatus: "failure",
        failedChecks: [{ name: "Checks", status: "failure", conclusion: "failure" }],
        checks: [
          { name: "Checks", status: "failure", conclusion: "failure" },
          { name: "Tests", status: "failure", conclusion: "failure" },
        ],
        settledAt: "2026-04-01T00:00:05.000Z",
        capturedAt: "2026-04-01T00:00:05.000Z",
      }),
      lastGitHubCiSnapshotSettledAt: "2026-04-01T00:00:05.000Z",
    });

    await handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildCheckRunPayload({
        branch: "feat-ci-stale-pass",
        headSha: "sha-old",
        prNumber: 50,
        checkName: "Tests",
        conclusion: "success",
      }).toString("utf8"),
    });

    const issue = db.getIssue("usertold", "issue-10");
    assert.equal(issue?.lastGitHubFailureSource, "branch_ci");
    assert.equal(issue?.lastGitHubFailureHeadSha, "sha-new");
    assert.equal(issue?.lastGitHubFailureCheckName, "Checks");
    assert.equal(issue?.lastGitHubCiSnapshotHeadSha, "sha-new");
    assert.equal(issue?.lastGitHubCiSnapshotGateCheckStatus, "failure");
    assert.deepEqual(enqueueCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
