import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      codex: { bin: "node", args: ["app-server"], approvalPolicy: "never", sandboxMode: "danger-full-access" },
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

function stubGh(baseDir: string, params: {
  prViewJson: string | string[];
  compareJson?: string;
}): string {
  const fakeBin = path.join(baseDir, "bin");
  const ghPath = path.join(fakeBin, "gh");
  const prViews = Array.isArray(params.prViewJson) ? params.prViewJson : [params.prViewJson];
  const prViewsPath = path.join(baseDir, "pr-views.json");
  const prViewIndexPath = path.join(baseDir, "pr-view-index");
  writeFileSync(prViewsPath, JSON.stringify(prViews), "utf8");
  writeFileSync(prViewIndexPath, "0", "utf8");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(ghPath, `#!/usr/bin/env node
const fs = require("node:fs");

if (process.argv[2] === "pr" && process.argv[3] === "view") {
  const views = JSON.parse(fs.readFileSync(${JSON.stringify(prViewsPath)}, "utf8"));
  const indexPath = ${JSON.stringify(prViewIndexPath)};
  const index = Number.parseInt(fs.readFileSync(indexPath, "utf8"), 10) || 0;
  const next = Math.min(index + 1, views.length - 1);
  fs.writeFileSync(indexPath, String(next));
  process.stdout.write(views[Math.min(index, views.length - 1)]);
  process.exit(0);
}
if (process.argv[2] === "api") {
  process.stdout.write(${JSON.stringify(params.compareJson ?? JSON.stringify({ files: [], commits: [] }))});
  process.exit(0);
}
process.exit(1);
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
    workflowOutcome: undefined as const,
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
    const fakeBin = stubGh(baseDir, { prViewJson: JSON.stringify({
      headRefOid: "sha-pr",
      state: "OPEN",
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    }) });
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
    const fakeBin = stubGh(baseDir, { prViewJson: JSON.stringify({
      headRefOid: "sha-pr",
      state: "OPEN",
      reviewDecision: "APPROVED",
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    }) });
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
    const fakeBin = stubGh(baseDir, { prViewJson: JSON.stringify({
      headRefOid: "sha-pr",
      state: "OPEN",
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    }) });
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, policy } = setupPolicy(baseDir);
    const issue = db.upsertIssue({ ...baseIssue(), workflowOutcome: undefined, lastGitHubFailureSource: "branch_ci" });
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

test("verifyReactiveRunAdvancedBranch accepts ci_repair same head after fresh successful gate", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reactive-noop-ci-green-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = stubGh(baseDir, { prViewJson: JSON.stringify({
      headRefOid: "sha-pr",
      state: "OPEN",
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [{
        __typename: "CheckRun",
        name: "verify",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        completedAt: "2999-01-01T00:00:00.000Z",
      }],
    }) });
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, policy } = setupPolicy(baseDir);
    const issue = db.upsertIssue({ ...baseIssue(), workflowOutcome: undefined, lastGitHubFailureSource: "branch_ci" });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "ci_repair",
    });

    const result = await policy.verifyReactiveRunAdvancedBranch(run, issue);
    assert.equal(result, undefined);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("verifyReviewFixAdvancedHead blocks returning the blocking review head to review", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-review-blocking-head-"));
  const oldPath = process.env.PATH;
  const oldRecheckDelays = process.env.PATCHRELAY_REVIEW_FIX_HEAD_RECHECK_DELAYS_MS;
  try {
    process.env.PATCHRELAY_REVIEW_FIX_HEAD_RECHECK_DELAYS_MS = "0";
    const fakeBin = stubGh(baseDir, { prViewJson: JSON.stringify({
      headRefOid: "sha-blocked",
      state: "OPEN",
      reviewDecision: "CHANGES_REQUESTED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    }) });
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, policy } = setupPolicy(baseDir);
    const issue = db.upsertIssue({
      ...baseIssue(),
      prReviewState: "changes_requested",
      lastBlockingReviewHeadSha: "sha-blocked",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
    });

    const result = await policy.verifyReviewFixAdvancedHead(run, issue);
    assert.match(result ?? "", /without pushing a new head/);
    assert.match(result ?? "", /sha-bloc/);
    assert.match(result ?? "", /same SHA back to review/);
  } finally {
    process.env.PATH = oldPath;
    if (oldRecheckDelays === undefined) {
      delete process.env.PATCHRELAY_REVIEW_FIX_HEAD_RECHECK_DELAYS_MS;
    } else {
      process.env.PATCHRELAY_REVIEW_FIX_HEAD_RECHECK_DELAYS_MS = oldRecheckDelays;
    }
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("verifyReviewFixAdvancedHead rechecks before failing a just-published repair", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-review-blocking-recheck-"));
  const oldPath = process.env.PATH;
  const oldRecheckDelays = process.env.PATCHRELAY_REVIEW_FIX_HEAD_RECHECK_DELAYS_MS;
  try {
    process.env.PATCHRELAY_REVIEW_FIX_HEAD_RECHECK_DELAYS_MS = "0";
    const fakeBin = stubGh(baseDir, { prViewJson: [
      JSON.stringify({
        headRefOid: "sha-blocked",
        state: "OPEN",
        reviewDecision: "CHANGES_REQUESTED",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      }),
      JSON.stringify({
        headRefOid: "sha-next",
        state: "OPEN",
        reviewDecision: "REVIEW_REQUIRED",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      }),
    ] });
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, policy } = setupPolicy(baseDir);
    const issue = db.upsertIssue({
      ...baseIssue(),
      prReviewState: "changes_requested",
      lastBlockingReviewHeadSha: "sha-blocked",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
    });

    const result = await policy.verifyReviewFixAdvancedHead(run, issue);
    assert.equal(result, undefined);
  } finally {
    process.env.PATH = oldPath;
    if (oldRecheckDelays === undefined) {
      delete process.env.PATCHRELAY_REVIEW_FIX_HEAD_RECHECK_DELAYS_MS;
    } else {
      process.env.PATCHRELAY_REVIEW_FIX_HEAD_RECHECK_DELAYS_MS = oldRecheckDelays;
    }
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("verifyReviewFixAdvancedHead accepts a head advanced beyond the blocking review SHA", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-review-blocking-advanced-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = stubGh(baseDir, { prViewJson: JSON.stringify({
      headRefOid: "sha-next",
      state: "OPEN",
      reviewDecision: "CHANGES_REQUESTED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    }) });
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, policy } = setupPolicy(baseDir);
    const issue = db.upsertIssue({
      ...baseIssue(),
      prReviewState: "changes_requested",
      lastBlockingReviewHeadSha: "sha-blocked",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
      sourceHeadSha: "sha-next",
    });

    const result = await policy.verifyReviewFixAdvancedHead(run, issue);
    assert.equal(result, undefined);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("verifyReviewFixAdvancedHead falls back to the run source head for older issue rows", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-review-source-fallback-"));
  const oldPath = process.env.PATH;
  const oldRecheckDelays = process.env.PATCHRELAY_REVIEW_FIX_HEAD_RECHECK_DELAYS_MS;
  try {
    process.env.PATCHRELAY_REVIEW_FIX_HEAD_RECHECK_DELAYS_MS = "0";
    const fakeBin = stubGh(baseDir, { prViewJson: JSON.stringify({
      headRefOid: "sha-source",
      state: "OPEN",
      reviewDecision: "CHANGES_REQUESTED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    }) });
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, policy } = setupPolicy(baseDir);
    const issue = db.upsertIssue({
      ...baseIssue(),
      prReviewState: "changes_requested",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
      sourceHeadSha: "sha-source",
    });

    const result = await policy.verifyReviewFixAdvancedHead(run, issue);
    assert.match(result ?? "", /without pushing a new head/);
    assert.match(result ?? "", /same SHA back to review/);
  } finally {
    process.env.PATH = oldPath;
    if (oldRecheckDelays === undefined) {
      delete process.env.PATCHRELAY_REVIEW_FIX_HEAD_RECHECK_DELAYS_MS;
    } else {
      process.env.PATCHRELAY_REVIEW_FIX_HEAD_RECHECK_DELAYS_MS = oldRecheckDelays;
    }
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("verifyReviewFixAdvancedHead fails closed when no blocking or starting head is recorded", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-review-no-head-"));
  try {
    const { db, policy } = setupPolicy(baseDir);
    const issue = db.upsertIssue({
      ...baseIssue(),
      prReviewState: "changes_requested",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
    });

    const result = await policy.verifyReviewFixAdvancedHead(run, issue);
    assert.match(result ?? "", /without a recorded blocking review or starting head SHA/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("resolveRequestedChangesWorkflowContext refreshes GitHub review context even when cached context exists", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-review-context-refresh-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = path.join(baseDir, "bin");
    const ghPath = path.join(fakeBin, "gh");
    const callsPath = path.join(baseDir, "gh-calls.log");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${callsPath}'
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s' '{"headRefOid":"sha-live","state":"OPEN","reviewDecision":"CHANGES_REQUESTED","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'
  exit 0
fi
if [ "$1" = "api" ] && [[ "$2" == *"/pulls/59/reviews?per_page=100" ]]; then
  printf '%s' '[{"id":123,"state":"CHANGES_REQUESTED","body":"Live review body","commit_id":"sha-reviewed","html_url":"https://github.test/review","user":{"login":"reviewer"}}]'
  exit 0
fi
if [ "$1" = "api" ] && [[ "$2" == *"/pulls/59/reviews/123/comments?per_page=100" ]]; then
  printf '%s' '[{"body":"Inline review comment","path":"src/app.ts","line":7,"side":"RIGHT","html_url":"https://github.test/comment","user":{"login":"reviewer"}}]'
  exit 0
fi
exit 1
`, "utf8");
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, policy } = setupPolicy(baseDir);
    const issue = db.upsertIssue({
      ...baseIssue(),
      prReviewState: "changes_requested",
    });

    const context = await policy.resolveRequestedChangesWorkflowContext(issue, "review_fix", {
      reviewBody: "stale cached review",
      reviewerName: "stale-reviewer",
    });

    assert.equal(context?.reviewContextStatus, "fresh");
    assert.equal(context?.reviewBody, "Live review body");
    assert.equal(context?.reviewerName, "reviewer");
    assert.equal(context?.reviewCommitId, "sha-reviewed");
    assert.equal(context?.currentPrHeadSha, "sha-live");
    assert.equal((context?.reviewComments as Array<Record<string, unknown>> | undefined)?.[0]?.body, "Inline review comment");
    const apiCalls = readFileSync(callsPath, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("api "));
    assert.equal(apiCalls.length, 2);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("resolveRequestedChangesWorkflowContext marks review context degraded when GitHub review fetch fails", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-review-context-degraded-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = path.join(baseDir, "bin");
    const ghPath = path.join(fakeBin, "gh");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s' '{"headRefOid":"sha-degraded","state":"OPEN","reviewDecision":"CHANGES_REQUESTED","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'
  exit 0
fi
if [ "$1" = "api" ]; then
  echo "GitHub unavailable" >&2
  exit 1
fi
exit 1
`, "utf8");
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, policy } = setupPolicy(baseDir);
    const issue = db.upsertIssue({
      ...baseIssue(),
      prReviewState: "changes_requested",
    });

    const context = await policy.resolveRequestedChangesWorkflowContext(issue, "review_fix", {
      reviewBody: "cached review that might be stale",
    });

    assert.equal(context?.reviewContextStatus, "degraded");
    assert.equal(context?.reviewContextDegraded, true);
    assert.equal(context?.reviewContextDegradedReason, "GitHub requested-changes review context could not be fetched before launch.");
    assert.equal(context?.reviewBody, "cached review that might be stale");
    assert.equal(context?.currentPrHeadSha, "sha-degraded");
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("refreshIssueAfterReactivePublish treats a head beyond the blocking review SHA as advanced", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-review-refresh-blocking-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = stubGh(baseDir, { prViewJson: JSON.stringify({
      headRefOid: "sha-next",
      state: "OPEN",
      reviewDecision: "CHANGES_REQUESTED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    }) });
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, policy } = setupPolicy(baseDir);
    const issue = db.upsertIssue({
      ...baseIssue(),
      prHeadSha: "sha-next",
      prReviewState: "changes_requested",
      lastBlockingReviewHeadSha: "sha-blocked",
      lastGitHubFailureHeadSha: "sha-next",
      lastGitHubFailureSignature: "queue_eviction::sha-next::merge-steward/queue",
    });
    assert.equal(db.issueSessions.forceAcquireIssueSessionLease({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      leaseId: "lease-1",
      workerId: "worker-1",
      leasedUntil: new Date(Date.now() + 60_000).toISOString(),
    }), true);
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
      sourceHeadSha: "sha-next",
    });

    await policy.refreshIssueAfterReactivePublish(run, issue);

    const updated = db.getIssue(issue.projectId, issue.linearIssueId);
    assert.equal(updated?.prCheckStatus, "pending");
    assert.equal(updated?.lastGitHubFailureHeadSha, undefined);
    assert.equal(updated?.lastGitHubFailureSignature, undefined);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("verifyReactiveRunStayedInScope blocks reactive review fixes that touch repo-meta files", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reactive-scope-drift-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = stubGh(baseDir, {
      prViewJson: JSON.stringify({
        headRefOid: "sha-next",
        state: "OPEN",
        reviewDecision: "CHANGES_REQUESTED",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      }),
      compareJson: JSON.stringify({
        files: [
          { filename: "package.json" },
          { filename: "src/paywall-copy.ts" },
        ],
        commits: [
          { commit: { message: "Fix paywall shortfall type narrowing" } },
        ],
      }),
    });
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, policy } = setupPolicy(baseDir);
    const issue = db.upsertIssue({
      ...baseIssue(),
      prReviewState: "changes_requested",
      lastGitHubFailureHeadSha: "sha-prev",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
      sourceHeadSha: "sha-prev",
    });

    const result = await policy.verifyReactiveRunStayedInScope(run, issue);
    assert.ok(result?.includes("widened scope"));
    assert.ok(result?.includes("package.json"));
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("verifyReactiveRunStayedInScope blocks reactive revert-stack cleanup", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reactive-revert-stack-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = stubGh(baseDir, {
      prViewJson: JSON.stringify({
        headRefOid: "sha-next",
        state: "OPEN",
        reviewDecision: "APPROVED",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      }),
      compareJson: JSON.stringify({
        files: [
          { filename: "src/paywall-copy.ts" },
        ],
        commits: [
          { commit: { message: "Revert \"Switch package manager from npm to pnpm\"\n\nThis reverts commit 123." } },
          { commit: { message: "Fix paywall headroom copy" } },
        ],
      }),
    });
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const { db, policy } = setupPolicy(baseDir);
    const issue = db.upsertIssue({
      ...baseIssue(),
      lastGitHubFailureHeadSha: "sha-prev",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "ci_repair",
    });

    const result = await policy.verifyReactiveRunStayedInScope(run, issue);
    assert.ok(result?.includes("revert commit"));
    assert.ok(result?.includes("Switch package manager from npm to pnpm"));
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});
