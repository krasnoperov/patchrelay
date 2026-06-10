import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { FACTORY_STATES, resolveFactoryStateFromGitHub } from "../src/factory-state.ts";
import type {
  GitHubCiSnapshotResolver,
  GitHubFailureContextResolver,
} from "../src/github-failure-context.ts";
import type { GitHubTriggerEvent } from "../src/github-types.ts";
import { GitHubWebhookHandler } from "../src/github-webhook-handler.ts";
import { IdleIssueReconciler } from "../src/idle-reconciliation.ts";
import { QueueHealthMonitor } from "../src/queue-health-monitor.ts";
import type { UpsertIssueParams } from "../src/db/issue-store.ts";
import type { AppConfig } from "../src/types.ts";
import { WakeDispatcher } from "../src/wake-dispatcher.ts";

// Lost-webhook re-derivation suite (core simplification plan, phase C exit
// criteria; docs/architecture.md "Recovery doctrine: re-derivation, not
// replay"). For each GitHub trigger event the projector handles, two worlds
// run over identical seed state:
//
//   - world A (delivered): the normalized webhook goes through the real
//     `GitHubWebhookHandler` pipeline (projector + reactive-run + terminal
//     handler), then reconciliation passes run as they would in production;
//   - world B (lost): the webhook never arrives; the SAME reconciliation
//     passes run against the polled PR snapshot GitHub would return after
//     the event (faked `gh pr view` / `gh api`).
//
// The doctrine holds when both worlds converge on the factory-state-relevant
// fields (factoryState, prState, prNumber, prReviewState, wake runType) and
// failure provenance follows `mayClearFailureProvenance` identically.
// Genuinely asymmetric pairs assert the documented difference explicitly.
//
// One "reconciliation pass" here is the production ordering inside
// `RunOrchestrator.reconcileActiveRuns`: queue health monitor, then the idle
// reconciler.

const PROJECT = "usertold";
const ISSUE = "issue-under-test";

function createConfig(baseDir: string, dbFileName: string): AppConfig {
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
      path: path.join(baseDir, dbFileName),
      // WAL keeps the per-world migrations fast (~2s each in rollback mode).
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
        id: PROJECT,
        repoPath: path.join(baseDir, "repo"),
        worktreeRoot: path.join(baseDir, "worktrees"),
        issueKeyPrefixes: ["USE"],
        linearTeamIds: ["USE"],
        allowLabels: [],
        reviewChecks: [],
        gateChecks: ["verify"],
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

// Stub resolvers stand in for the projector's GitHub API lookups: the
// snapshot resolver settles to whatever the check event reported, and the
// failure-context resolver returns the structured context a real lookup
// would have produced for that event.
function buildStubResolvers(): { failureContextResolver: GitHubFailureContextResolver; ciSnapshotResolver: GitHubCiSnapshotResolver } {
  return {
    failureContextResolver: {
      resolve: async ({ source, repoFullName, event }) => ({
        source,
        repoFullName,
        capturedAt: new Date().toISOString(),
        ...(event.headSha ? { headSha: event.headSha } : {}),
        ...(event.checkName ? { checkName: event.checkName } : {}),
        ...(event.checkUrl ? { checkUrl: event.checkUrl } : {}),
        summary: "stubbed failure context",
        failureSignature: [source, event.headSha ?? "unknown-sha", event.checkName ?? "verify"].join("::"),
      }),
    },
    ciSnapshotResolver: {
      resolve: async ({ event }) => {
        if (!event.headSha || !event.checkStatus || event.checkStatus === "pending") return undefined;
        return {
          headSha: event.headSha,
          gateCheckName: event.checkName ?? "verify",
          gateCheckStatus: event.checkStatus,
          checks: [{ name: event.checkName ?? "verify", status: event.checkStatus, conclusion: event.checkStatus }],
          failedChecks: event.checkStatus === "failure"
            ? [{ name: event.checkName ?? "verify", status: "failure", conclusion: "failure" }]
            : [],
          settledAt: new Date().toISOString(),
          capturedAt: new Date().toISOString(),
        };
      },
    },
  };
}

interface World {
  name: string;
  db: PatchRelayDatabase;
  handler: GitHubWebhookHandler;
  reconciler: IdleIssueReconciler;
  queueMonitor: QueueHealthMonitor;
  enqueueCalls: Array<{ projectId: string; issueId: string }>;
}

function createWorld(baseDir: string, name: string): World {
  const config = createConfig(baseDir, `${name}.sqlite`);
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();
  const logger = pino({ enabled: false });
  const enqueueCalls: Array<{ projectId: string; issueId: string }> = [];
  const wake = new WakeDispatcher(
    db,
    (projectId, issueId) => {
      enqueueCalls.push({ projectId, issueId });
    },
    () => undefined,
    logger,
  );
  const resolvers = buildStubResolvers();
  const handler = new GitHubWebhookHandler(
    config,
    db,
    { forProject: async () => undefined } as never,
    wake,
    logger,
    { steerTurn: async () => undefined } as never,
    undefined,
    resolvers.failureContextResolver,
    resolvers.ciSnapshotResolver,
    (async () => {
      throw new Error("network disabled in tests");
    }) as never,
  );
  const reconciler = new IdleIssueReconciler(db, config, wake, logger);
  const queueMonitor = new QueueHealthMonitor(
    db,
    config,
    {
      advanceIdleIssue: (issue, newState, options) => {
        reconciler.advanceIdleIssue(issue, newState, options);
      },
      wakeDispatcher: wake,
    },
    logger,
  );
  return { name, db, handler, reconciler, queueMonitor, enqueueCalls };
}

function createWorldPair(baseDir: string): { delivered: World; lost: World; close: () => void } {
  const delivered = createWorld(baseDir, "delivered");
  const lost = createWorld(baseDir, "lost");
  return {
    delivered,
    lost,
    close: () => {
      delivered.db.close();
      lost.db.close();
    },
  };
}

function seedBoth(pair: { delivered: World; lost: World }, params: Omit<UpsertIssueParams, "projectId" | "linearIssueId">): void {
  for (const world of [pair.delivered, pair.lost]) {
    world.db.upsertIssue({ projectId: PROJECT, linearIssueId: ISSUE, ...params });
  }
}

function backdateIssueUpdatedAt(world: World, ageMs: number): void {
  world.db.unsafeRawConnectionForTests()
    .prepare("UPDATE issues SET updated_at = ? WHERE project_id = ? AND linear_issue_id = ?")
    .run(new Date(Date.now() - ageMs).toISOString(), PROJECT, ISSUE);
}

// One production-ordered reconciliation pass (queue monitor, then idle).
async function runReconciliationPass(world: World): Promise<void> {
  await world.queueMonitor.reconcile();
  await world.reconciler.reconcile();
}

// The factory-state-relevant fields the doctrine is asserted over.
function captureConvergedFacts(world: World) {
  const issue = world.db.getIssue(PROJECT, ISSUE);
  assert.ok(issue, `${world.name}: issue row must exist`);
  return {
    factoryState: issue.factoryState,
    prState: issue.prState ?? null,
    prNumber: issue.prNumber ?? null,
    prReviewState: issue.prReviewState ?? null,
    prCheckStatus: issue.prCheckStatus ?? null,
    failureSource: issue.lastGitHubFailureSource ?? null,
    failureHeadSha: issue.lastGitHubFailureHeadSha ?? null,
    wakeRunType: world.db.workflowWakes.peekIssueWake(PROJECT, ISSUE)?.runType ?? null,
  };
}

function installFakeGh(baseDir: string, responses: { prView?: unknown; apiStdout?: string }): () => void {
  const fakeBin = path.join(baseDir, "bin");
  const ghPath = path.join(fakeBin, "gh");
  mkdirSync(fakeBin, { recursive: true });
  const prViewJson = JSON.stringify(JSON.stringify(responses.prView ?? {}));
  writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s' ${prViewJson}
  exit 0
fi
if [ "$1" = "api" ]; then
  printf '%s' ${JSON.stringify(responses.apiStdout ?? "")}
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`, "utf8");
  chmodSync(ghPath, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;
  return () => {
    process.env.PATH = oldPath;
  };
}

// ─── Webhook payload builders (real GitHub shapes; the handler runs the
// production normalizer over them) ───────────────────────────────────

function buildReviewPayload(params: {
  state: "approved" | "changes_requested" | "commented";
  branch: string;
  headSha: string;
  prNumber: number;
}): string {
  return JSON.stringify({
    action: "submitted",
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: params.prNumber,
      html_url: `https://github.com/owner/repo/pull/${params.prNumber}`,
      title: `PR for #${params.prNumber}`,
      body: "",
      state: "open",
      merged: false,
      user: { login: "patchrelay[bot]" },
      head: { ref: params.branch, sha: params.headSha },
      base: { ref: "main" },
    },
    review: {
      id: 901,
      state: params.state,
      body: params.state === "changes_requested" ? "Please tighten this up." : "Looks fine.",
      commit_id: params.headSha,
      user: { login: "reviewbot" },
    },
  });
}

function buildPullRequestPayload(params: {
  action: "opened" | "synchronize" | "closed";
  branch: string;
  headSha: string;
  prNumber: number;
  merged?: boolean;
  state?: string;
  authorLogin?: string;
}): string {
  return JSON.stringify({
    action: params.action,
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: params.prNumber,
      html_url: `https://github.com/owner/repo/pull/${params.prNumber}`,
      title: `PR for #${params.prNumber}`,
      body: "",
      state: params.state ?? (params.action === "closed" ? "closed" : "open"),
      merged: params.merged ?? false,
      user: { login: params.authorLogin ?? "patchrelay[bot]" },
      head: { ref: params.branch, sha: params.headSha },
      base: { ref: "main" },
    },
  });
}

function buildCheckRunPayload(params: {
  branch: string;
  headSha: string;
  prNumber: number;
  checkName: string;
  conclusion: "success" | "failure" | null;
}): string {
  return JSON.stringify({
    action: params.conclusion === null ? "in_progress" : "completed",
    repository: { full_name: "owner/repo" },
    check_run: {
      conclusion: params.conclusion,
      ...(params.conclusion === null ? { status: "in_progress" } : {}),
      name: params.checkName,
      html_url: `https://github.com/owner/repo/actions/runs/${params.prNumber}`,
      details_url: `https://github.com/owner/repo/actions/runs/${params.prNumber}`,
      head_sha: params.headSha,
      output: {
        title: `${params.checkName} ${params.conclusion ?? "running"}`,
        summary: `${params.checkName} ${params.conclusion ?? "running"}`,
      },
      check_suite: {
        head_branch: params.branch,
        pull_requests: [{ number: params.prNumber, head: { ref: params.branch } }],
      },
    },
  });
}

function rollupEntry(name: string, conclusion: "SUCCESS" | "FAILURE" | null) {
  return conclusion === null
    ? { __typename: "CheckRun", name, status: "IN_PROGRESS", conclusion: null }
    : { __typename: "CheckRun", name, status: "COMPLETED", conclusion };
}

// ─── review_approved ─────────────────────────────────────────────────

test("lost review_approved: poll converges to awaiting_queue identically", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-lost-approved-"));
  const restoreGh = installFakeGh(baseDir, {
    prView: {
      headRefOid: "sha-appr",
      state: "OPEN",
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [rollupEntry("verify", "SUCCESS")],
    },
  });
  const pair = createWorldPair(baseDir);
  try {
    seedBoth(pair, {
      issueKey: "USE-A1",
      branchName: "feat-approved",
      prNumber: 10,
      prState: "open",
      prHeadSha: "sha-appr",
      prAuthorLogin: "patchrelay[bot]",
      prReviewState: "commented",
      prCheckStatus: "success",
      factoryState: "pr_open",
      delegatedToPatchRelay: true,
    });

    await pair.delivered.handler.processGitHubWebhookEvent({
      eventType: "pull_request_review",
      rawBody: buildReviewPayload({ state: "approved", branch: "feat-approved", headSha: "sha-appr", prNumber: 10 }),
    });
    assert.equal(pair.delivered.db.getIssue(PROJECT, ISSUE)?.factoryState, "awaiting_queue");

    await runReconciliationPass(pair.delivered);
    await runReconciliationPass(pair.lost);

    const a = captureConvergedFacts(pair.delivered);
    const b = captureConvergedFacts(pair.lost);
    assert.equal(b.factoryState, "awaiting_queue");
    assert.deepEqual(b, a, "lost review_approved must re-derive the exact delivered state");
  } finally {
    pair.close();
    restoreGh();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── review_changes_requested ────────────────────────────────────────

test("lost review_changes_requested: poll converges to changes_requested with the same review_fix wake", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-lost-changes-"));
  const restoreGh = installFakeGh(baseDir, {
    prView: {
      headRefOid: "sha-rcr",
      state: "OPEN",
      reviewDecision: "CHANGES_REQUESTED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [rollupEntry("verify", "SUCCESS")],
    },
  });
  // Make sure the delivered path does not try to fetch inline review
  // comments (it only does so when a token is present).
  const oldGithubToken = process.env.GITHUB_TOKEN;
  const oldGhToken = process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  const pair = createWorldPair(baseDir);
  try {
    seedBoth(pair, {
      issueKey: "USE-A2",
      branchName: "feat-changes",
      prNumber: 11,
      prState: "open",
      prHeadSha: "sha-rcr",
      prAuthorLogin: "patchrelay[bot]",
      prCheckStatus: "success",
      factoryState: "pr_open",
      delegatedToPatchRelay: true,
    });

    await pair.delivered.handler.processGitHubWebhookEvent({
      eventType: "pull_request_review",
      rawBody: buildReviewPayload({ state: "changes_requested", branch: "feat-changes", headSha: "sha-rcr", prNumber: 11 }),
    });

    await runReconciliationPass(pair.delivered);
    await runReconciliationPass(pair.lost);

    const a = captureConvergedFacts(pair.delivered);
    const b = captureConvergedFacts(pair.lost);
    assert.equal(b.factoryState, "changes_requested");
    assert.equal(b.wakeRunType, "review_fix");
    assert.deepEqual(b, a, "lost review_changes_requested must re-derive the delivered state");

    // Documented asymmetry (cosmetic, not behavior-driving): the webhook
    // carries the review body for the run prompt; the poll only knows the
    // review decision. Both wakes still dispatch the same review_fix run.
    const deliveredWake = pair.delivered.db.workflowWakes.peekIssueWake(PROJECT, ISSUE);
    const lostWake = pair.lost.db.workflowWakes.peekIssueWake(PROJECT, ISSUE);
    assert.equal(deliveredWake?.context.reviewBody, "Please tighten this up.");
    assert.equal(lostWake?.context.reviewBody, undefined);
  } finally {
    if (oldGithubToken !== undefined) process.env.GITHUB_TOKEN = oldGithubToken;
    if (oldGhToken !== undefined) process.env.GH_TOKEN = oldGhToken;
    pair.close();
    restoreGh();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── review_commented ────────────────────────────────────────────────

test("lost review_commented: poll records the same non-decisive review state with no transition", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-lost-commented-"));
  const restoreGh = installFakeGh(baseDir, {
    prView: {
      headRefOid: "sha-cmt",
      state: "OPEN",
      reviewDecision: "REVIEW_REQUIRED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [rollupEntry("verify", "SUCCESS")],
    },
  });
  const pair = createWorldPair(baseDir);
  try {
    seedBoth(pair, {
      issueKey: "USE-A3",
      branchName: "feat-commented",
      prNumber: 12,
      prState: "open",
      prHeadSha: "sha-cmt",
      prAuthorLogin: "patchrelay[bot]",
      prCheckStatus: "success",
      factoryState: "pr_open",
      delegatedToPatchRelay: true,
    });

    await pair.delivered.handler.processGitHubWebhookEvent({
      eventType: "pull_request_review",
      rawBody: buildReviewPayload({ state: "commented", branch: "feat-commented", headSha: "sha-cmt", prNumber: 12 }),
    });

    await runReconciliationPass(pair.delivered);
    await runReconciliationPass(pair.lost);

    const a = captureConvergedFacts(pair.delivered);
    const b = captureConvergedFacts(pair.lost);
    assert.equal(b.factoryState, "pr_open", "a non-decisive review must not transition the issue");
    assert.equal(b.prReviewState, "commented");
    assert.deepEqual(b, a);
  } finally {
    pair.close();
    restoreGh();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── check_pending ───────────────────────────────────────────────────

test("lost check_pending: poll records the same pending gate status", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-lost-pending-"));
  const restoreGh = installFakeGh(baseDir, {
    prView: {
      headRefOid: "sha-pend",
      state: "OPEN",
      reviewDecision: "REVIEW_REQUIRED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [rollupEntry("verify", null)],
    },
  });
  const pair = createWorldPair(baseDir);
  try {
    seedBoth(pair, {
      issueKey: "USE-A4",
      branchName: "feat-pending",
      prNumber: 13,
      prState: "open",
      prHeadSha: "sha-pend",
      prAuthorLogin: "patchrelay[bot]",
      prCheckStatus: "success",
      factoryState: "pr_open",
      delegatedToPatchRelay: true,
    });

    await pair.delivered.handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildCheckRunPayload({ branch: "feat-pending", headSha: "sha-pend", prNumber: 13, checkName: "verify", conclusion: null }),
    });

    await runReconciliationPass(pair.delivered);
    await runReconciliationPass(pair.lost);

    const a = captureConvergedFacts(pair.delivered);
    const b = captureConvergedFacts(pair.lost);
    assert.equal(b.prCheckStatus, "pending");
    assert.equal(b.factoryState, "pr_open");
    assert.deepEqual(b, a);
  } finally {
    pair.close();
    restoreGh();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── check_failed (branch_ci) ────────────────────────────────────────

test("lost check_failed (branch_ci): poll records equivalent failure provenance and routes the same ci_repair", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-lost-check-failed-"));
  const restoreGh = installFakeGh(baseDir, {
    prView: {
      headRefOid: "sha-red1",
      state: "OPEN",
      reviewDecision: "REVIEW_REQUIRED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [rollupEntry("verify", "FAILURE")],
    },
    apiStdout: "", // no merge-steward eviction check-run on this head
  });
  const pair = createWorldPair(baseDir);
  try {
    seedBoth(pair, {
      issueKey: "USE-A5",
      branchName: "feat-red",
      prNumber: 14,
      prState: "open",
      prHeadSha: "sha-red1",
      prAuthorLogin: "patchrelay[bot]",
      // Seeded to match what the poll derives from REVIEW_REQUIRED: the
      // check webhook carries no review facts, so an unseeded review state
      // would diverge cosmetically (poll enriches it, webhook leaves it).
      prReviewState: "commented",
      prCheckStatus: "pending",
      factoryState: "pr_open",
      delegatedToPatchRelay: true,
      lastGitHubCiSnapshotHeadSha: "sha-red1",
      lastGitHubCiSnapshotGateCheckName: "verify",
      lastGitHubCiSnapshotGateCheckStatus: "pending",
    });

    await pair.delivered.handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildCheckRunPayload({ branch: "feat-red", headSha: "sha-red1", prNumber: 14, checkName: "verify", conclusion: "failure" }),
    });

    // The lost world needs two passes by design: the first ingests the
    // polled level facts (red settled gate), the second routes the repair
    // from those facts. Assert the intermediate state explicitly so the
    // two-pass shape is executable documentation, not an accident.
    await runReconciliationPass(pair.lost);
    const lostAfterFirstPass = pair.lost.db.getIssue(PROJECT, ISSUE);
    assert.equal(lostAfterFirstPass?.prCheckStatus, "failure", "pass 1 must ingest the settled red gate");
    assert.equal(lostAfterFirstPass?.factoryState, "pr_open", "routing happens on the next pass");

    await runReconciliationPass(pair.delivered);
    await runReconciliationPass(pair.delivered);
    await runReconciliationPass(pair.lost);

    const a = captureConvergedFacts(pair.delivered);
    const b = captureConvergedFacts(pair.lost);
    assert.equal(b.factoryState, "repairing_ci");
    assert.equal(b.failureSource, "branch_ci");
    assert.equal(b.failureHeadSha, "sha-red1");
    assert.equal(b.wakeRunType, "ci_repair");
    assert.deepEqual(b, a, "behavior-driving failure facts must converge");

    // Documented asymmetry (cosmetic, not behavior-driving): the webhook
    // resolves a structured failure signature and check name from the
    // check-run payload; the poll-side inference only proves "the gate is
    // red on this head" and leaves them empty. The repair routing keys off
    // source + head, which both worlds agree on.
    assert.equal(pair.delivered.db.getIssue(PROJECT, ISSUE)?.lastGitHubFailureSignature, "branch_ci::sha-red1::verify");
    assert.equal(pair.lost.db.getIssue(PROJECT, ISSUE)?.lastGitHubFailureSignature, undefined);
  } finally {
    pair.close();
    restoreGh();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── check_failed (queue_eviction) ───────────────────────────────────

test("lost check_failed (queue_eviction): queue health probe routes the same queue_repair", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-lost-eviction-"));
  const restoreGh = installFakeGh(baseDir, {
    prView: {
      headRefOid: "sha-evict",
      state: "OPEN",
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [rollupEntry("verify", "SUCCESS")],
    },
    apiStdout: "merge-steward/queue", // the eviction check-run IS failed on this head
  });
  const pair = createWorldPair(baseDir);
  try {
    seedBoth(pair, {
      issueKey: "USE-A6",
      branchName: "feat-evict",
      prNumber: 15,
      prState: "open",
      prHeadSha: "sha-evict",
      prAuthorLogin: "patchrelay[bot]",
      prReviewState: "approved",
      prCheckStatus: "success",
      factoryState: "awaiting_queue",
      delegatedToPatchRelay: true,
    });
    // The queue health probe only fires once the issue has sat in the queue
    // past its grace period — the webhook would have arrived long before.
    backdateIssueUpdatedAt(pair.delivered, 5 * 60_000);
    backdateIssueUpdatedAt(pair.lost, 5 * 60_000);

    await pair.delivered.handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildCheckRunPayload({ branch: "feat-evict", headSha: "sha-evict", prNumber: 15, checkName: "merge-steward/queue", conclusion: "failure" }),
    });

    await runReconciliationPass(pair.delivered);
    await runReconciliationPass(pair.lost);

    const a = captureConvergedFacts(pair.delivered);
    const b = captureConvergedFacts(pair.lost);
    // The behavior-driving outcome converges: both worlds hold a pending
    // queue_repair wake that was dispatched to the work queue.
    assert.equal(a.wakeRunType, "queue_repair");
    assert.equal(b.wakeRunType, "queue_repair");
    assert.ok(pair.delivered.enqueueCalls.some((call) => call.issueId === ISSUE));
    assert.ok(pair.lost.enqueueCalls.some((call) => call.issueId === ISSUE));

    // Documented asymmetry 1: the webhook records full queue-eviction
    // provenance (lastGitHubFailureSource + the steward incident payload);
    // the queue-health probe proves the eviction from the check-runs API
    // and records the attempted-failure markers + a requiresFreshHead
    // repair context instead. Both worlds route the identical repair run;
    // the lost world's incident detail is the poll-side minimum.
    assert.equal(a.failureSource, "queue_eviction");
    assert.equal(b.failureSource, null);
    // The probe's incident identity lives in the wake context (the
    // attempted-failure row markers it also writes are wiped again by the
    // idle pass's approved-branch provenance clear — nothing concrete is
    // recorded in lastGitHubFailure*, so clearing is considered harmless).
    const lostWake = pair.lost.db.workflowWakes.peekIssueWake(PROJECT, ISSUE);
    assert.equal(lostWake?.context.failureSignature, "same_head_queue_eviction:sha-evict");
    assert.equal(lostWake?.context.requiresFreshHead, true);

    // Documented asymmetry 2 (consequence of asymmetry 1): the delivered
    // world keeps the repairing_queue compatibility state because the
    // recorded provenance re-routes it on every idle pass; the lost world's
    // monitor sets repairing_queue but — having recorded NO provenance —
    // the idle poll's approved rule flips the row back to awaiting_queue in
    // the SAME pass. The dispatched wake (asserted above) still drives the
    // repair, so the divergence is the operator-facing state label, not the
    // routed work.
    assert.equal(a.factoryState, "repairing_queue");
    assert.equal(b.factoryState, "awaiting_queue");
  } finally {
    pair.close();
    restoreGh();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── check_passed: the provenance-clearing doctrine ──────────────────

test("lost check_passed: green gate on the failure head clears branch_ci provenance identically", { concurrency: false }, async () => {
  // The failure head never advanced — the red check was re-run and went
  // green on the SAME head. Per mayClearFailureProvenance, a green gate on
  // the recorded failure head clears branch_ci provenance on both paths.
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-lost-green-same-head-"));
  const restoreGh = installFakeGh(baseDir, {
    prView: {
      headRefOid: "sha-flaky",
      state: "OPEN",
      reviewDecision: "REVIEW_REQUIRED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [rollupEntry("verify", "SUCCESS")],
    },
  });
  const pair = createWorldPair(baseDir);
  try {
    seedBoth(pair, {
      issueKey: "USE-A7",
      branchName: "feat-flaky",
      prNumber: 16,
      prState: "open",
      prHeadSha: "sha-flaky",
      prAuthorLogin: "patchrelay[bot]",
      prCheckStatus: "failure",
      factoryState: "escalated",
      delegatedToPatchRelay: true,
      lastGitHubFailureSource: "branch_ci",
      lastGitHubFailureHeadSha: "sha-flaky",
      lastGitHubFailureSignature: "branch_ci::sha-flaky::verify",
      lastGitHubFailureCheckName: "verify",
      lastGitHubCiSnapshotHeadSha: "sha-flaky",
      lastGitHubCiSnapshotGateCheckName: "verify",
      lastGitHubCiSnapshotGateCheckStatus: "failure",
    });

    await pair.delivered.handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildCheckRunPayload({ branch: "feat-flaky", headSha: "sha-flaky", prNumber: 16, checkName: "verify", conclusion: "success" }),
    });
    // The webhook clears provenance immediately per the rule.
    assert.equal(pair.delivered.db.getIssue(PROJECT, ISSUE)?.lastGitHubFailureSource, undefined);

    await runReconciliationPass(pair.delivered);
    await runReconciliationPass(pair.lost);

    const a = captureConvergedFacts(pair.delivered);
    const b = captureConvergedFacts(pair.lost);
    assert.equal(b.factoryState, "pr_open", "terminal recovery reopens the issue from the green truth");
    assert.equal(b.failureSource, null, "green gate on the failure head must clear branch_ci provenance on the poll path too");
    assert.deepEqual(b, a);
  } finally {
    pair.close();
    restoreGh();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("lost check_passed: green BRANCH gate does NOT clear queue_eviction provenance on either path", { concurrency: false }, async () => {
  // The swallowed-repair doctrine: a queue eviction means integration with
  // main broke; a green branch gate proves nothing about that. Neither the
  // delivered check_passed nor the poll may clear the queue provenance —
  // both worlds must keep it and route the queue repair from it.
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-lost-green-queue-"));
  const restoreGh = installFakeGh(baseDir, {
    prView: {
      headRefOid: "sha-q1",
      state: "OPEN",
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [rollupEntry("verify", "SUCCESS")],
    },
    apiStdout: "", // the historical eviction has no live check-run anymore
  });
  const pair = createWorldPair(baseDir);
  try {
    seedBoth(pair, {
      issueKey: "USE-A8",
      branchName: "feat-q1",
      prNumber: 17,
      prState: "open",
      prHeadSha: "sha-q1",
      prAuthorLogin: "patchrelay[bot]",
      prReviewState: "approved",
      prCheckStatus: "failure",
      factoryState: "escalated",
      delegatedToPatchRelay: true,
      lastGitHubFailureSource: "queue_eviction",
      lastGitHubFailureHeadSha: "sha-q1",
      lastGitHubFailureSignature: "queue_eviction::sha-q1::merge-steward/queue",
      lastGitHubFailureCheckName: "merge-steward/queue",
      lastGitHubCiSnapshotHeadSha: "sha-q1",
      lastGitHubCiSnapshotGateCheckName: "verify",
      lastGitHubCiSnapshotGateCheckStatus: "failure",
    });

    await pair.delivered.handler.processGitHubWebhookEvent({
      eventType: "check_run",
      rawBody: buildCheckRunPayload({ branch: "feat-q1", headSha: "sha-q1", prNumber: 17, checkName: "verify", conclusion: "success" }),
    });
    assert.equal(
      pair.delivered.db.getIssue(PROJECT, ISSUE)?.lastGitHubFailureSource,
      "queue_eviction",
      "the delivered green branch gate must not clear queue provenance",
    );

    // Pass 1: terminal recovery reopens to awaiting_queue, provenance kept.
    await runReconciliationPass(pair.delivered);
    await runReconciliationPass(pair.lost);
    for (const world of [pair.delivered, pair.lost]) {
      const issue = world.db.getIssue(PROJECT, ISSUE);
      assert.equal(issue?.factoryState, "awaiting_queue", `${world.name}: pass 1 reopens from the green truth`);
      assert.equal(issue?.lastGitHubFailureSource, "queue_eviction", `${world.name}: queue provenance must survive the green poll`);
    }

    // Pass 2: the surviving provenance routes the queue repair.
    await runReconciliationPass(pair.delivered);
    await runReconciliationPass(pair.lost);

    const a = captureConvergedFacts(pair.delivered);
    const b = captureConvergedFacts(pair.lost);
    assert.equal(b.factoryState, "repairing_queue");
    assert.equal(b.failureSource, "queue_eviction");
    assert.equal(b.wakeRunType, "queue_repair");
    assert.deepEqual(b, a, "the preserved queue provenance must drive the same repair in both worlds");
  } finally {
    pair.close();
    restoreGh();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── pr_synchronize ──────────────────────────────────────────────────

test("lost pr_synchronize: poll with the advanced head clears provenance; repair budgets do NOT reset (documented divergence)", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-lost-sync-"));
  const restoreGh = installFakeGh(baseDir, {
    prView: {
      headRefOid: "sha-new",
      state: "OPEN",
      reviewDecision: "REVIEW_REQUIRED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [rollupEntry("verify", null)],
    },
  });
  const pair = createWorldPair(baseDir);
  try {
    seedBoth(pair, {
      issueKey: "USE-A9",
      branchName: "feat-sync",
      prNumber: 18,
      prState: "open",
      prHeadSha: "sha-old",
      prAuthorLogin: "patchrelay[bot]",
      prCheckStatus: "failure",
      factoryState: "escalated",
      delegatedToPatchRelay: true,
      ciRepairAttempts: 2,
      lastGitHubFailureSource: "branch_ci",
      lastGitHubFailureHeadSha: "sha-old",
      lastGitHubFailureSignature: "branch_ci::sha-old::verify",
      lastGitHubFailureCheckName: "verify",
    });

    await pair.delivered.handler.processGitHubWebhookEvent({
      eventType: "pull_request",
      rawBody: buildPullRequestPayload({ action: "synchronize", branch: "feat-sync", headSha: "sha-new", prNumber: 18 }),
    });

    await runReconciliationPass(pair.delivered);
    await runReconciliationPass(pair.lost);

    const a = captureConvergedFacts(pair.delivered);
    const b = captureConvergedFacts(pair.lost);
    // headIsCurrentTruth: the polled head superseded the failure head, so
    // provenance clears and the terminal issue reopens — identically.
    assert.equal(b.factoryState, "pr_open");
    assert.equal(b.prCheckStatus, "pending");
    assert.equal(b.failureSource, null);
    assert.equal(pair.lost.db.getIssue(PROJECT, ISSUE)?.prHeadSha, "sha-new");
    assert.deepEqual(b, a, "factory-state facts and provenance must converge");

    // FINDING (documented divergence, do not weaken): the webhook path
    // resets the repair budgets on every push (projector pr_synchronize
    // branch writes ciRepairAttempts/queueRepairAttempts = 0); the
    // re-derivation path clears provenance via mayClearFailureProvenance
    // but has NO budget-reset rule. After a lost pr_synchronize the fresh
    // head starts with the old head's consumed budget, so it escalates
    // earlier than the delivered world would. The doctrine (plan §C1
    // "clears provenance + resets repair budgets equivalently") wants these
    // equal — flagged for a production fix rather than silently asserted
    // away here.
    assert.equal(pair.delivered.db.getIssue(PROJECT, ISSUE)?.ciRepairAttempts, 0);
    assert.equal(
      pair.lost.db.getIssue(PROJECT, ISSUE)?.ciRepairAttempts,
      2,
      "known divergence: the poll path does not reset repair budgets on head advance (see FINDING above)",
    );
  } finally {
    pair.close();
    restoreGh();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── pr_merged ───────────────────────────────────────────────────────

test("lost pr_merged: poll converges to done and clears provenance identically", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-lost-merged-"));
  const restoreGh = installFakeGh(baseDir, {
    prView: {
      headRefOid: "sha-mrg",
      state: "MERGED",
      reviewDecision: "APPROVED",
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
      statusCheckRollup: [],
    },
    apiStdout: "",
  });
  const pair = createWorldPair(baseDir);
  try {
    seedBoth(pair, {
      issueKey: "USE-A10",
      branchName: "feat-merged",
      prNumber: 19,
      prState: "open",
      prHeadSha: "sha-mrg",
      prAuthorLogin: "patchrelay[bot]",
      prReviewState: "approved",
      prCheckStatus: "success",
      factoryState: "awaiting_queue",
      delegatedToPatchRelay: true,
      // A merge supersedes any recorded failure: both paths must clear it.
      lastGitHubFailureSource: "queue_eviction",
      lastGitHubFailureHeadSha: "sha-mrg",
      lastGitHubFailureSignature: "queue_eviction::sha-mrg::merge-steward/queue",
      lastQueueIncidentJson: JSON.stringify({ failureReason: "queue_eviction" }),
    });
    // Let the queue health probe (the awaiting_queue poll owner) run.
    backdateIssueUpdatedAt(pair.delivered, 5 * 60_000);
    backdateIssueUpdatedAt(pair.lost, 5 * 60_000);

    await pair.delivered.handler.processGitHubWebhookEvent({
      eventType: "pull_request",
      rawBody: buildPullRequestPayload({ action: "closed", merged: true, branch: "feat-merged", headSha: "sha-mrg", prNumber: 19 }),
    });

    await runReconciliationPass(pair.delivered);
    await runReconciliationPass(pair.lost);

    const a = captureConvergedFacts(pair.delivered);
    const b = captureConvergedFacts(pair.lost);
    assert.equal(b.factoryState, "done");
    assert.equal(b.prState, "merged");
    assert.equal(b.failureSource, null, "a merged PR supersedes any recorded failure");
    assert.equal(pair.lost.db.getIssue(PROJECT, ISSUE)?.lastQueueIncidentJson, undefined);
    assert.deepEqual(b, a);
  } finally {
    pair.close();
    restoreGh();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── pr_closed ───────────────────────────────────────────────────────

test("lost pr_closed: poll converges to the redelegate disposition with the same implementation wake", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-lost-closed-"));
  const restoreGh = installFakeGh(baseDir, {
    prView: {
      headRefOid: "sha-cls",
      state: "CLOSED",
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
      statusCheckRollup: [],
    },
  });
  const pair = createWorldPair(baseDir);
  try {
    seedBoth(pair, {
      issueKey: "USE-A11",
      branchName: "feat-closed",
      prNumber: 20,
      prState: "open",
      prHeadSha: "sha-cls",
      prAuthorLogin: "patchrelay[bot]",
      prReviewState: "commented",
      prCheckStatus: "success",
      factoryState: "pr_open",
      delegatedToPatchRelay: true,
      currentLinearState: "In Progress",
      currentLinearStateType: "started",
    });

    await pair.delivered.handler.processGitHubWebhookEvent({
      eventType: "pull_request",
      rawBody: buildPullRequestPayload({ action: "closed", merged: false, branch: "feat-closed", headSha: "sha-cls", prNumber: 20 }),
    });

    await runReconciliationPass(pair.delivered);
    await runReconciliationPass(pair.lost);

    const a = captureConvergedFacts(pair.delivered);
    const b = captureConvergedFacts(pair.lost);
    // Unfinished delegated work whose PR was closed is re-delegated for a
    // fresh implementation on both paths; the PR-shaped review/check
    // metadata is wiped by buildClosedPrCleanupFields on both.
    assert.equal(b.factoryState, "delegated");
    assert.equal(b.prState, "closed");
    assert.equal(b.prReviewState, null);
    assert.equal(b.wakeRunType, "implementation");
    assert.deepEqual(b, a);
  } finally {
    pair.close();
    restoreGh();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── pr_opened ───────────────────────────────────────────────────────

test("lost pr_opened: documented asymmetry - the GitHub poll cannot discover a PR it has no number for", { concurrency: false }, async () => {
  // The idle reconciler re-derives state by polling a KNOWN pr_number; a
  // lost pr_opened means no number was ever recorded, so this is the one
  // trigger event the GitHub poll cannot re-derive by construction.
  // Recovery for this case is owned by the Linear-side reconciliation
  // (linked-PR attachments / delegation recovery), not the GitHub poll —
  // asserted here as the documented asymmetry so the gap stays visible.
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-lost-opened-"));
  const restoreGh = installFakeGh(baseDir, {
    prView: {
      headRefOid: "sha-opn",
      state: "OPEN",
      reviewDecision: "REVIEW_REQUIRED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [rollupEntry("verify", null)],
    },
  });
  const pair = createWorldPair(baseDir);
  try {
    seedBoth(pair, {
      issueKey: "USE-A12",
      branchName: "feat-opened",
      factoryState: "implementing",
      delegatedToPatchRelay: true,
    });

    await pair.delivered.handler.processGitHubWebhookEvent({
      eventType: "pull_request",
      rawBody: buildPullRequestPayload({ action: "opened", branch: "feat-opened", headSha: "sha-opn", prNumber: 21, authorLogin: "human-dev" }),
    });

    await runReconciliationPass(pair.delivered);
    await runReconciliationPass(pair.lost);

    const a = captureConvergedFacts(pair.delivered);
    assert.equal(a.factoryState, "pr_open");
    assert.equal(a.prNumber, 21);
    assert.equal(a.prState, "open");

    const b = captureConvergedFacts(pair.lost);
    assert.equal(b.prNumber, null, "no webhook, no PR number - nothing for the poll to re-derive from");
    assert.equal(b.factoryState, "implementing", "the lost world intentionally stays put; Linear-side reconciliation owns this recovery");
  } finally {
    pair.close();
    restoreGh();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── merge_group_* + trigger-event coverage ──────────────────────────

test("merge_group events are inert by design and every trigger event is accounted for", () => {
  // merge_group_passed / merge_group_failed exist in the normalizer but
  // have no transition rule: the merge queue is operated by the external
  // merge steward, whose signals reach PatchRelay as check_run events
  // (merge-steward/queue) — there is nothing for re-derivation to recover.
  for (const state of FACTORY_STATES) {
    assert.equal(resolveFactoryStateFromGitHub("merge_group_passed", state, {}), undefined);
    assert.equal(resolveFactoryStateFromGitHub("merge_group_failed", state, {}), undefined);
  }

  // Coverage guard: this suite must account for every GitHubTriggerEvent.
  // Adding a new trigger event makes the type-level assertion below fail
  // until the event gets a delivered/lost pair (or a documented-inert entry).
  const accountedFor = [
    "pr_opened", // documented asymmetry: poll cannot discover an unknown PR
    "pr_synchronize", // pair + documented budget-reset divergence (FINDING)
    "pr_closed", // pair
    "pr_merged", // pair
    "review_approved", // pair
    "review_changes_requested", // pair
    "review_commented", // pair
    "check_pending", // pair
    "check_passed", // two doctrine pairs (branch_ci clears, queue_eviction survives)
    "check_failed", // two pairs (branch_ci, queue_eviction)
    "merge_group_passed", // documented inert (steward owns the queue)
    "merge_group_failed", // documented inert (steward owns the queue)
  ] as const satisfies readonly GitHubTriggerEvent[];
  type Unaccounted = Exclude<GitHubTriggerEvent, (typeof accountedFor)[number]>;
  const unaccounted: Unaccounted[] = [];
  assert.deepEqual(unaccounted, []);
  assert.equal(new Set<string>(accountedFor).size, accountedFor.length);
});
