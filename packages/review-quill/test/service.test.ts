import assert from "node:assert/strict";
import test from "node:test";
import { ReviewQuillService } from "../src/service.ts";
import { GitHubApiError } from "../src/github-client.ts";
import { normalizeVerdict } from "../src/review-runner.ts";
import { extractFirstJsonObject, forgivingJsonParse, sanitizeJsonPayload } from "../src/utils.ts";

test("normalizeVerdict accepts the rich schema and passes it through", () => {
  const raw = {
    walkthrough: "This PR refactors the admission loop and fixes a race condition.",
    architectural_concerns: [
      { severity: "nit", category: "convention", message: "Inconsistent error handling across the new admission code." },
    ],
    findings: [
      { path: "src/admission.ts", line: 142, severity: "blocking", message: "Missing mutex release on error path", confidence: 90 },
      { path: "src/admission.ts", line: 198, severity: "nit", message: "Consider renaming for clarity", confidence: 60 },
    ],
    verdict: "request_changes",
    verdict_reason: "One blocking finding on the error path.",
  };
  const result = normalizeVerdict(raw);
  assert.equal(result.walkthrough, raw.walkthrough);
  assert.equal(result.verdict, "request_changes");
  assert.equal(result.architectural_concerns.length, 1);
  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0]?.confidence, 90);
  assert.equal(result.verdict_reason, "One blocking finding on the error path.");
});

test("normalizeVerdict falls back to legacy `summary` when `walkthrough` is absent", () => {
  const raw = {
    summary: "Legacy single-field summary.",
    findings: [],
    verdict: "approve",
  };
  const result = normalizeVerdict(raw);
  assert.equal(result.walkthrough, "Legacy single-field summary.");
  assert.equal(result.verdict, "approve");
});

test("normalizeVerdict demotes request_changes to approve when no blocking findings exist", () => {
  // Model asked for request_changes but only has nit findings. The
  // normalizer enforces the binary merge-gate rule.
  const raw = {
    walkthrough: "Walkthrough.",
    findings: [{ path: "a.ts", line: 1, severity: "nit", message: "naming" }],
    architectural_concerns: [],
    verdict: "request_changes",
    verdict_reason: "Model thought this was blocking but it is not.",
  };
  const result = normalizeVerdict(raw);
  assert.equal(result.verdict, "approve");
});

test("getWatchSnapshot counts only the latest attempt per pull request", () => {
  const service = new ReviewQuillService(
    {
      server: { bind: "127.0.0.1", port: 8788 },
      database: { path: ":memory:", wal: true },
      logging: { level: "info" },
      reconciliation: {
        pollIntervalMs: 1_000,
        heartbeatIntervalMs: 1_000,
        staleQueuedAfterMs: 60_000,
        staleRunningAfterMs: 60_000,
      },
      codex: {
        bin: "codex",
        args: [],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      },
      prompting: { replaceSections: {} },
      repositories: [
        {
          repoId: "ballony-i-nasosy",
          repoFullName: "krasnoperov/ballony-i-nasosy",
          baseBranch: "main",
          requiredChecks: [],
          excludeBranches: [],
          reviewDocs: [],
          diffIgnore: [],
          diffSummarizeOnly: [],
          patchBodyBudgetTokens: 5_000,
        },
      ],
      secretSources: {},
    } as never,
    {
      listAttempts: () => [
        {
          id: 1,
          repoFullName: "krasnoperov/ballony-i-nasosy",
          prNumber: 55,
          headSha: "old",
          status: "failed",
          conclusion: "error",
          createdAt: "2026-04-09T20:00:00.000Z",
          updatedAt: "2026-04-09T20:01:00.000Z",
        },
        {
          id: 2,
          repoFullName: "krasnoperov/ballony-i-nasosy",
          prNumber: 55,
          headSha: "new",
          status: "completed",
          conclusion: "approved",
          createdAt: "2026-04-09T20:02:00.000Z",
          updatedAt: "2026-04-09T20:03:00.000Z",
        },
      ],
      listWebhooks: () => [],
    } as never,
    {} as never,
    {} as never,
    { child: () => ({}) } as never,
  );

  const snapshot = service.getWatchSnapshot();
  assert.equal(snapshot.summary.totalAttempts, 1);
  assert.equal(snapshot.summary.failedAttempts, 0);
  assert.equal(snapshot.summary.completedAttempts, 1);
  assert.equal(snapshot.repos[0]?.failedAttempts, 0);
  assert.equal(snapshot.repos[0]?.completedAttempts, 1);
});

test("getAttemptDetail includes current pull request state when GitHub data is available", async () => {
  const service = new ReviewQuillService(
    {
      server: { bind: "127.0.0.1", port: 8788 },
      database: { path: ":memory:", wal: true },
      logging: { level: "info" },
      reconciliation: {
        pollIntervalMs: 1_000,
        heartbeatIntervalMs: 1_000,
        staleQueuedAfterMs: 60_000,
        staleRunningAfterMs: 60_000,
      },
      codex: {
        bin: "codex",
        args: [],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      },
      prompting: { replaceSections: {} },
      repositories: [
        {
          repoId: "subtitles",
          repoFullName: "krasnoperov/subtitles",
          baseBranch: "main",
          requiredChecks: [],
          excludeBranches: [],
          reviewDocs: [],
          diffIgnore: [],
          diffSummarizeOnly: [],
          patchBodyBudgetTokens: 5_000,
        },
      ],
      secretSources: {},
    } as never,
    {
      getAttemptById: () => ({
        id: 231,
        repoFullName: "krasnoperov/subtitles",
        prNumber: 16,
        headSha: "9f64980040eccbcebca45599b015ca36187e928b",
        status: "completed",
        conclusion: "approved",
        createdAt: "2026-04-11T23:50:24.691Z",
        updatedAt: "2026-04-12T00:07:46.364Z",
        completedAt: "2026-04-12T00:07:46.363Z",
      }),
      listAttemptsForPullRequest: () => [],
    } as never,
    {
      getPullRequest: async () => ({
        number: 16,
        title: "Fix 502 error during conversation",
        url: "https://github.com/krasnoperov/subtitles/pull/16",
        state: "MERGED",
        isDraft: false,
        headSha: "9f64980040eccbcebca45599b015ca36187e928b",
        headRefName: "krasnoperov-subtitles/LSR-5-fix-502-error-during-conversation",
        baseRefName: "main",
        mergedAt: "2026-04-12T00:39:00.000Z",
        closedAt: "2026-04-12T00:39:00.000Z",
      }),
    } as never,
    {} as never,
    { child: () => ({}) } as never,
  );

  const detail = await service.getAttemptDetail(231);
  assert.ok(detail);
  assert.equal(detail.currentPullRequest?.state, "MERGED");
  assert.equal(detail.currentPullRequest?.headSha, "9f64980040eccbcebca45599b015ca36187e928b");
});

test("triggerReconcile retires active attempts for merged pull requests", async () => {
  const activeAttempt = {
    id: 226,
    repoFullName: "krasnoperov/subtitles",
    prNumber: 15,
    headSha: "0e987ee9f80ed2b165d41aeb5ea0b32c04dd61dd",
    status: "running",
    createdAt: "2026-04-11T22:28:56.962Z",
    updatedAt: "2026-04-11T22:28:56.971Z",
  } as const;

  let storedAttempt: Record<string, unknown> = { ...activeAttempt };
  const updates: Array<Record<string, unknown>> = [];

  const service = new ReviewQuillService(
    {
      server: { bind: "127.0.0.1", port: 8788 },
      database: { path: ":memory:", wal: true },
      logging: { level: "info" },
      reconciliation: {
        pollIntervalMs: 1_000,
        heartbeatIntervalMs: 1_000,
        staleQueuedAfterMs: 60_000,
        staleRunningAfterMs: 60_000,
      },
      codex: {
        bin: "codex",
        args: [],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      },
      prompting: { replaceSections: {} },
      repositories: [
        {
          repoId: "subtitles",
          repoFullName: "krasnoperov/subtitles",
          baseBranch: "main",
          requiredChecks: [],
          excludeBranches: [],
          reviewDocs: [],
          diffIgnore: [],
          diffSummarizeOnly: [],
          patchBodyBudgetTokens: 5_000,
        },
      ],
      secretSources: {},
    } as never,
    {
      listAttempts: () => [],
      listWebhooks: () => [],
      listActiveAttemptsForRepo: () => [storedAttempt],
      listAttemptsForPullRequest: () => [],
      getAttempt: () => undefined,
      updateAttempt: (_id: number, params: Record<string, unknown>) => {
        updates.push(params);
        storedAttempt = {
          ...storedAttempt,
          ...params,
        };
        return storedAttempt;
      },
    } as never,
    {
      listOpenPullRequests: async () => [],
      getPullRequest: async () => ({
        number: 15,
        title: "Tutor consolidation",
        url: "https://github.com/krasnoperov/subtitles/pull/15",
        state: "MERGED",
        isDraft: false,
        headSha: "0e987ee9f80ed2b165d41aeb5ea0b32c04dd61dd",
        headRefName: "feat/tutor",
        baseRefName: "main",
        mergedAt: "2026-04-11T22:29:32Z",
        closedAt: "2026-04-11T22:29:32Z",
      }),
    } as never,
    {} as never,
    { info() {}, warn() {}, child() { return this; } } as never,
  );

  await service.triggerReconcile();

  assert.equal(storedAttempt.status, "cancelled");
  assert.equal(storedAttempt.conclusion, "skipped");
  assert.match(String(storedAttempt.summary), /merged before the review attempt finished/i);
  assert.equal(updates.length, 1);
});

test("executeReview skips stale heads before starting Codex review work", async () => {
  const existingAttempt = {
    id: 99,
    repoFullName: "krasnoperov/subtitles",
    prNumber: 1220,
    headSha: "old-head",
    status: "failed",
    conclusion: "error",
    threadId: "old-thread",
    turnId: "old-turn",
    transcript: { id: "old-thread", turns: [{ id: "old-turn", status: "failed", items: [] }] },
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:01:00.000Z",
  } as const;
  let storedAttempt: Record<string, unknown> | undefined = { ...existingAttempt };
  const updates: Array<Record<string, unknown>> = [];
  let runnerCalled = false;

  const service = new ReviewQuillService(
    {
      server: { bind: "127.0.0.1", port: 8788 },
      database: { path: ":memory:", wal: true },
      logging: { level: "info" },
      reconciliation: {
        pollIntervalMs: 1_000,
        heartbeatIntervalMs: 1_000,
        staleQueuedAfterMs: 60_000,
        staleRunningAfterMs: 60_000,
      },
      codex: {
        bin: "codex",
        args: [],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      },
      prompting: { replaceSections: {} },
      repositories: [
        {
          repoId: "subtitles",
          repoFullName: "krasnoperov/subtitles",
          baseBranch: "main",
          requiredChecks: [],
          excludeBranches: [],
          reviewDocs: [],
          diffIgnore: [],
          diffSummarizeOnly: [],
          patchBodyBudgetTokens: 5_000,
        },
      ],
      secretSources: {},
    } as never,
    {
      createAttempt: (params: Record<string, unknown>) => {
        storedAttempt = {
          id: 99,
          ...params,
          createdAt: "2026-05-25T00:00:00.000Z",
          updatedAt: "2026-05-25T00:00:00.000Z",
        };
        return storedAttempt;
      },
      updateAttempt: (_id: number, params: Record<string, unknown>) => {
        updates.push(params);
        storedAttempt = {
          ...storedAttempt,
          ...params,
        };
        return storedAttempt;
      },
      setAttemptTitle: () => undefined,
    } as never,
    {
      getPullRequest: async () => ({
        number: 1220,
        title: "Translate S01E26 Modelo treinta to EN+RU",
        url: "https://github.com/krasnoperov/subtitles/pull/1220",
        state: "OPEN",
        isDraft: false,
        headSha: "new-head",
        headRefName: "feature/podcast-translate-s01e26",
        baseRefName: "main",
        labels: [],
      }),
    } as never,
    {
      review: async () => {
        runnerCalled = true;
        throw new Error("runner should not be called for stale heads");
      },
    } as never,
    { info() {}, warn() {}, error() {}, child() { return this; } } as never,
  );

  await (service as unknown as {
    executeReview: (
      repo: unknown,
      pr: unknown,
      existing?: unknown,
      identity?: unknown,
    ) => Promise<void>;
  }).executeReview(
    {
      repoId: "subtitles",
      repoFullName: "krasnoperov/subtitles",
      baseBranch: "main",
      requiredChecks: [],
      excludeBranches: [],
      reviewDocs: [],
      diffIgnore: [],
      diffSummarizeOnly: [],
      patchBodyBudgetTokens: 5_000,
    },
    {
      number: 1220,
      title: "Translate S01E26 Modelo treinta to EN+RU",
      url: "https://github.com/krasnoperov/subtitles/pull/1220",
      state: "OPEN",
      isDraft: false,
      headSha: "old-head",
      headRefName: "feature/podcast-translate-s01e26",
      baseRefName: "main",
      labels: [],
    },
    existingAttempt,
  );

  assert.equal(runnerCalled, false);
  assert.equal(storedAttempt?.status, "superseded");
  assert.equal(storedAttempt?.conclusion, "skipped");
  assert.match(String(storedAttempt?.summary), /Superseded by newer head new-head/);
  assert.ok(updates.some((update) => update.status === "running"));
  assert.ok(updates.some((update) => update.status === "superseded"));
  assert.ok(!updates.some((update) => update.threadId === null || update.turnId === null || update.transcript === null));
  assert.equal(storedAttempt?.threadId, "old-thread");
  assert.equal(storedAttempt?.turnId, "old-turn");
  assert.deepEqual(storedAttempt?.transcript, existingAttempt.transcript);
});

test("triggerReconcile does not re-review an unchanged head after PR metadata edits", async () => {
  const reviewedAttempt = {
    id: 301,
    repoFullName: "krasnoperov/subtitles",
    prNumber: 32,
    headSha: "same-head",
    status: "completed",
    conclusion: "declined",
    prTitle: "Original title",
    promptFingerprint: "old-fingerprint",
    createdAt: "2026-05-28T09:00:00.000Z",
    updatedAt: "2026-05-28T09:01:00.000Z",
    completedAt: "2026-05-28T09:01:00.000Z",
  };
  let executionCount = 0;

  const service = new ReviewQuillService(
    {
      server: { bind: "127.0.0.1", port: 8788 },
      database: { path: ":memory:", wal: true },
      logging: { level: "info" },
      reconciliation: {
        pollIntervalMs: 1_000,
        heartbeatIntervalMs: 1_000,
        staleQueuedAfterMs: 60_000,
        staleRunningAfterMs: 60_000,
      },
      codex: {
        bin: "codex",
        args: [],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      },
      prompting: { replaceSections: {} },
      repositories: [
        {
          repoId: "subtitles",
          repoFullName: "krasnoperov/subtitles",
          baseBranch: "main",
          requiredChecks: [],
          excludeBranches: [],
          reviewDocs: [],
          diffIgnore: [],
          diffSummarizeOnly: [],
          patchBodyBudgetTokens: 5_000,
        },
      ],
      secretSources: {},
    } as never,
    {
      listAttempts: () => [],
      listWebhooks: () => [],
      listActiveAttemptsForRepo: () => [],
      listAttemptsForPullRequest: () => [reviewedAttempt],
      getAttempt: () => reviewedAttempt,
      updateAttempt: () => reviewedAttempt,
    } as never,
    {
      listOpenPullRequests: async () => [
        {
          number: 32,
          title: "Updated title",
          body: "Updated description",
          url: "https://github.com/krasnoperov/subtitles/pull/32",
          state: "OPEN",
          isDraft: false,
          headSha: "same-head",
          headRefName: "feat/metadata-only",
          baseRefName: "main",
          labels: [],
        },
      ],
      listPullRequestReviews: async () => [],
      listCheckRuns: async () => [{ name: "verify", status: "completed", conclusion: "success" }],
    } as never,
    {} as never,
    { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as never,
  );

  (service as unknown as {
    executeReview: () => Promise<void>;
  }).executeReview = async () => {
    executionCount += 1;
  };

  await service.triggerReconcile();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(executionCount, 0);
});

test("triggerReconcile recovers a running attempt left behind by service restart and queues a retry", async () => {
  const staleAttempt = {
    id: 300,
    repoFullName: "krasnoperov/subtitles",
    prNumber: 31,
    headSha: "restart-head",
    status: "running",
    createdAt: "2026-05-28T09:00:00.000Z",
    updatedAt: "2026-05-28T09:00:10.000Z",
  };
  let storedAttempt: Record<string, unknown> = { ...staleAttempt };
  const updates: Array<Record<string, unknown>> = [];
  let executionCount = 0;
  let dispatchedPr: { number: number; headSha: string } | undefined;

  const service = new ReviewQuillService(
    {
      server: { bind: "127.0.0.1", port: 8788 },
      database: { path: ":memory:", wal: true },
      logging: { level: "info" },
      reconciliation: {
        pollIntervalMs: 1_000,
        heartbeatIntervalMs: 1_000,
        staleQueuedAfterMs: 60_000,
        staleRunningAfterMs: 60_000,
      },
      codex: {
        bin: "codex",
        args: [],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      },
      prompting: { replaceSections: {} },
      repositories: [
        {
          repoId: "subtitles",
          repoFullName: "krasnoperov/subtitles",
          baseBranch: "main",
          requiredChecks: [],
          excludeBranches: [],
          reviewDocs: [],
          diffIgnore: [],
          diffSummarizeOnly: [],
          patchBodyBudgetTokens: 5_000,
        },
      ],
      secretSources: {},
    } as never,
    {
      listAttempts: () => [],
      listWebhooks: () => [],
      listActiveAttemptsForRepo: () => [storedAttempt],
      listAttemptsForPullRequest: () => [storedAttempt],
      getAttempt: () => storedAttempt,
      findApprovedAttemptByPatchId: () => undefined,
      findApprovedAttemptByPatchAndTree: () => undefined,
      updateAttempt: (_id: number, params: Record<string, unknown>) => {
        updates.push(params);
        storedAttempt = { ...storedAttempt, ...params };
        return storedAttempt;
      },
    } as never,
    {
      listOpenPullRequests: async () => [
        {
          number: 31,
          title: "Retry after restart",
          url: "https://github.com/krasnoperov/subtitles/pull/31",
          state: "OPEN",
          isDraft: false,
          headSha: "restart-head",
          headRefName: "feat/restart-head",
          baseRefName: "main",
          labels: ["review:no-cache"],
        },
      ],
      listPullRequestReviews: async () => [],
      listCheckRuns: async () => [{ name: "verify", status: "completed", conclusion: "success" }],
    } as never,
    {} as never,
    { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as never,
  );

  (service as unknown as {
    executeReview: (
      repo: unknown,
      pr: { number: number; headSha: string },
      existing?: unknown,
      identity?: unknown,
      signal?: AbortSignal,
    ) => Promise<void>;
  }).executeReview = async (_repo, pr) => {
    executionCount += 1;
    dispatchedPr = pr;
  };

  await service.triggerReconcile();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(storedAttempt.status, "failed");
  assert.equal(storedAttempt.conclusion, "error");
  assert.match(String(storedAttempt.summary), /left running across a review-quill restart/i);
  assert.ok(updates.some((update) => update.status === "failed"));
  assert.equal(executionCount, 1);
  assert.equal(dispatchedPr?.number, 31);
  assert.equal(dispatchedPr?.headSha, "restart-head");
});

function buildParallelTestService(
  options: {
    repos?: Array<{ repoId: string; repoFullName: string }>;
    maxConcurrentReviews?: number;
  } = {},
): ReviewQuillService {
  const repos = options.repos ?? [
    { repoId: "alpha", repoFullName: "krasnoperov/alpha" },
    { repoId: "beta", repoFullName: "krasnoperov/beta" },
  ];
  return new ReviewQuillService(
    {
      server: { bind: "127.0.0.1", port: 8788 },
      database: { path: ":memory:", wal: true },
      logging: { level: "info" },
      reconciliation: {
        pollIntervalMs: 1_000,
        heartbeatIntervalMs: 1_000,
        staleQueuedAfterMs: 60_000,
        staleRunningAfterMs: 60_000,
        ...(options.maxConcurrentReviews !== undefined
          ? { maxConcurrentReviews: options.maxConcurrentReviews }
          : {}),
      },
      codex: {
        bin: "codex",
        args: [],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      },
      prompting: { replaceSections: {} },
      repositories: repos.map((repo) => ({
        repoId: repo.repoId,
        repoFullName: repo.repoFullName,
        baseBranch: "main",
        requiredChecks: [],
        excludeBranches: [],
        reviewDocs: [],
        diffIgnore: [],
        diffSummarizeOnly: [],
        patchBodyBudgetTokens: 5_000,
      })),
      secretSources: {},
    } as never,
    {
      listAttempts: () => [],
      listWebhooks: () => [],
    } as never,
    {} as never,
    {} as never,
    { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as never,
  );
}

test("discovery passes run in parallel — neither repo blocks the other", async () => {
  const service = buildParallelTestService();
  const order: string[] = [];
  const repoEntered = new Map<string, () => void>();
  const repoEnteredPromises = new Map<string, Promise<void>>();
  for (const name of ["krasnoperov/alpha", "krasnoperov/beta"]) {
    repoEnteredPromises.set(name, new Promise<void>((resolve) => repoEntered.set(name, resolve)));
  }

  // Stub discoverRepo: announce entry, then wait for the OTHER repo to also
  // enter. If discovery is serialized, this deadlocks — neither repo can
  // proceed because each waits on the other.
  (service as unknown as {
    discoverRepo: (repo: { repoFullName: string }) => Promise<void>;
  }).discoverRepo = async (repo) => {
    order.push(`enter:${repo.repoFullName}`);
    repoEntered.get(repo.repoFullName)!();
    const otherName = repo.repoFullName === "krasnoperov/alpha"
      ? "krasnoperov/beta"
      : "krasnoperov/alpha";
    await repoEnteredPromises.get(otherName)!;
    order.push(`exit:${repo.repoFullName}`);
  };

  await service.triggerReconcile();

  // Both repos must have entered before either exited — proves parallelism.
  assert.deepEqual(
    order.slice(0, 2).sort(),
    ["enter:krasnoperov/alpha", "enter:krasnoperov/beta"],
  );
});

test("reconcile outcome is failed when every repo discovery fails with GitHub auth errors", async () => {
  const service = buildParallelTestService();

  (service as unknown as {
    discoverRepo: (repo: { repoFullName: string }) => Promise<void>;
  }).discoverRepo = async () => {
    throw new GitHubApiError(401, "/repos/owner/repo/pulls", "Bad credentials");
  };

  await service.triggerReconcile();

  const runtime = service.getWatchSnapshot().runtime;
  assert.equal(runtime.lastReconcileOutcome, "failed");
  assert.match(runtime.lastReconcileError ?? "", /Bad credentials/);
  assert.equal(Object.keys(runtime.repoLastReconcileErrors).length, 2);
});

test("dispatchReview deduplicates the same (repo, pr, head) — only one execution runs", async () => {
  const service = buildParallelTestService();
  let executionCount = 0;
  let release!: () => void;
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });

  (service as unknown as {
    executeReview: () => Promise<void>;
  }).executeReview = async () => {
    executionCount += 1;
    await releasePromise;
  };

  const repo = { repoFullName: "krasnoperov/alpha", repoId: "alpha" } as never;
  const pr = { number: 1, headSha: "abc" } as never;

  const dispatch = (service as unknown as {
    dispatchReview: (
      repo: unknown,
      pr: unknown,
      existing?: unknown,
      identity?: unknown,
    ) => Promise<void>;
  }).dispatchReview.bind(service);

  // Three back-to-back dispatches for the same (repo, pr, headSha) — only
  // one execution should actually run; the others share the in-flight
  // promise.
  const a = dispatch(repo, pr);
  const b = dispatch(repo, pr);
  const c = dispatch(repo, pr);

  // All three references must be the same promise.
  assert.equal(a, b);
  assert.equal(b, c);

  release();
  await Promise.all([a, b, c]);
  assert.equal(executionCount, 1);
});

test("dispatchReview aborts older in-flight workers for the same pull request", async () => {
  const service = buildParallelTestService();
  const signals = new Map<string, AbortSignal | undefined>();
  const release: Array<() => void> = [];

  (service as unknown as {
    executeReview: (
      repo: unknown,
      pr: { headSha: string },
      existing?: unknown,
      identity?: unknown,
      signal?: AbortSignal,
    ) => Promise<void>;
  }).executeReview = async (_repo, pr, _existing, _identity, signal) => {
    signals.set(pr.headSha, signal);
    await new Promise<void>((resolve) => release.push(resolve));
  };

  const dispatch = (service as unknown as {
    dispatchReview: (
      repo: unknown,
      pr: unknown,
      existing?: unknown,
      identity?: unknown,
    ) => Promise<void>;
  }).dispatchReview.bind(service);

  const repo = { repoFullName: "krasnoperov/alpha", repoId: "alpha" } as never;
  const oldWork = dispatch(repo, { number: 1, headSha: "old-head" } as never);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals.get("old-head")?.aborted, false);

  const newWork = dispatch(repo, { number: 1, headSha: "new-head" } as never);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals.get("old-head")?.aborted, true);
  assert.match(String(signals.get("old-head")?.reason), /Superseded by newer head new-head/);
  assert.equal(signals.get("new-head")?.aborted, false);

  while (release.length > 0) {
    release.shift()!();
  }
  await Promise.all([oldWork, newWork]);
});

test("review semaphore caps in-flight executions at maxConcurrentReviews", async () => {
  const service = buildParallelTestService({ maxConcurrentReviews: 2 });
  let inFlight = 0;
  let peakInFlight = 0;
  const releasers: Array<() => void> = [];

  (service as unknown as {
    executeReview: (repo: { repoFullName: string }, pr: { number: number }) => Promise<void>;
  }).executeReview = async () => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    await new Promise<void>((resolve) => releasers.push(resolve));
    inFlight -= 1;
  };

  const dispatch = (service as unknown as {
    dispatchReview: (
      repo: unknown,
      pr: unknown,
      existing?: unknown,
      identity?: unknown,
    ) => Promise<void>;
  }).dispatchReview.bind(service);

  // Dispatch five distinct reviews; cap is 2.
  const work = Array.from({ length: 5 }, (_, i) =>
    dispatch(
      { repoFullName: "krasnoperov/alpha", repoId: "alpha" } as never,
      { number: i + 1, headSha: `sha-${i + 1}` } as never,
    ),
  );

  // Yield enough microtasks for the first batch to acquire slots.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inFlight, 2, "exactly two reviews should be in flight after the burst");

  // Release one; another should immediately enter the slot.
  releasers.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inFlight, 2, "freeing a slot should let the next review acquire");

  // Release the rest.
  while (releasers.length > 0) {
    releasers.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(work);

  assert.equal(peakInFlight, 2, "in-flight count must never exceed the cap");
  assert.equal(inFlight, 0, "all reviews must have completed");
});

test("triggerReconcile fans out reviews as independent workers", async () => {
  // End-to-end: discovery walks two repos, identifies one PR each that
  // needs a review, dispatches both. The Codex turns run in parallel,
  // not serialized.
  const service = buildParallelTestService();
  const startedAt = new Map<number, number>();
  const completed: number[] = [];
  const release: Array<() => void> = [];

  (service as unknown as {
    discoverRepo: (repo: { repoFullName: string; repoId: string }) => Promise<void>;
  }).discoverRepo = async (repo) => {
    // Each repo "discovers" one PR that needs a review.
    const dispatch = (service as unknown as {
      dispatchReview: (
        repo: unknown,
        pr: unknown,
        existing?: unknown,
        identity?: unknown,
      ) => Promise<void>;
    }).dispatchReview.bind(service);
    const prNumber = repo.repoFullName === "krasnoperov/alpha" ? 1 : 2;
    dispatch(
      repo as never,
      { number: prNumber, headSha: `${repo.repoFullName}-sha` } as never,
    );
  };

  (service as unknown as {
    executeReview: (repo: unknown, pr: { number: number }) => Promise<void>;
  }).executeReview = async (_repo, pr) => {
    startedAt.set(pr.number, Date.now());
    await new Promise<void>((resolve) => release.push(resolve));
    completed.push(pr.number);
  };

  // Trigger discovery; it returns once dispatch has been called for both
  // PRs (executeReview promises are not awaited inside discovery).
  await service.triggerReconcile();

  // Both reviews should have started immediately (parallel), within one
  // microtask tick of each other.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(startedAt.size, 2, "both reviews must start under parallelism");

  // Drain.
  while (release.length > 0) {
    release.shift()!();
  }
  // Wait for in-flight workers to settle.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(completed.sort(), [1, 2]);
});

test("sanitizeJsonPayload strips markdown fences", () => {
  assert.equal(sanitizeJsonPayload("```json\n{\"a\":1}\n```"), "{\"a\":1}");
  assert.equal(sanitizeJsonPayload("```\n{\"a\":1}\n```"), "{\"a\":1}");
});

test("sanitizeJsonPayload strips trailing commas before } and ]", () => {
  assert.equal(sanitizeJsonPayload("{\"a\":1,\"b\":[1,2,],}"), "{\"a\":1,\"b\":[1,2]}");
});

test("sanitizeJsonPayload strips // line and /* block */ comments", () => {
  assert.equal(
    sanitizeJsonPayload("{\"a\":1 // trailing note\n,\"b\":/* block */ 2}"),
    "{\"a\":1 \n,\"b\": 2}",
  );
});

test("forgivingJsonParse succeeds on clean JSON without touching it", () => {
  const parsed = forgivingJsonParse<{ a: number }>("{\"a\":1}");
  assert.deepEqual(parsed, { a: 1 });
});

test("forgivingJsonParse recovers from markdown fences", () => {
  const parsed = forgivingJsonParse<{ verdict: string }>("```json\n{\"verdict\":\"approve\"}\n```");
  assert.deepEqual(parsed, { verdict: "approve" });
});

test("forgivingJsonParse recovers from trailing commas", () => {
  const parsed = forgivingJsonParse<{ a: number[] }>("{\"a\":[1,2,3,],}");
  assert.deepEqual(parsed, { a: [1, 2, 3] });
});

test("extractFirstJsonObject returns the OUTERMOST top-level object even when it contains nested objects", () => {
  // Reproduces a bug where the extractor returned the LAST balanced
  // block in the text — for the rich verdict schema, that's the LAST
  // element of `findings[]`, not the top-level verdict. The fix:
  // walk forward from the FIRST `{` and let the depth-tracking walker
  // close the outermost block.
  const text = JSON.stringify({
    walkthrough: "Real review walkthrough.",
    architectural_concerns: [
      { severity: "nit", category: "convention", message: "minor convention drift" },
    ],
    findings: [
      { path: "src/a.ts", line: 1, severity: "blocking", message: "first finding" },
      { path: "src/b.ts", line: 2, severity: "nit", message: "last finding" },
    ],
    verdict: "request_changes",
    verdict_reason: "blocking finding present",
  });
  const extracted = extractFirstJsonObject(text);
  assert.ok(extracted);
  const parsed = JSON.parse(extracted!) as { walkthrough: string; findings: unknown[] };
  // Must be the outermost object, not the last finding
  assert.equal(parsed.walkthrough, "Real review walkthrough.");
  assert.equal(parsed.findings.length, 2);
});

test("extractFirstJsonObject ignores prose before and after the JSON", () => {
  const text = "Here is the review:\n{\"walkthrough\":\"x\",\"verdict\":\"approve\"}\n\nLet me know if you need more.";
  const extracted = extractFirstJsonObject(text);
  assert.ok(extracted);
  const parsed = JSON.parse(extracted!) as { walkthrough: string };
  assert.equal(parsed.walkthrough, "x");
});

test("extractFirstJsonObject skips a malformed first attempt and finds a valid later one", () => {
  // First brace-block is malformed (unbalanced, never closes). Walker
  // returns undefined for it; we move to the next `{` and find the
  // valid object.
  const text = "{ this is not really json\n\nbut here is the real one: {\"walkthrough\":\"recovery\",\"verdict\":\"approve\"}";
  const extracted = extractFirstJsonObject(text);
  assert.ok(extracted);
  const parsed = JSON.parse(extracted!) as { walkthrough: string };
  assert.equal(parsed.walkthrough, "recovery");
});

test("normalizeVerdict accepts case-variant severity values", () => {
  const raw = {
    walkthrough: "x",
    verdict: "request_changes",
    findings: [
      { path: "a.ts", line: 1, severity: "BLOCKING", message: "upper" },
      { path: "b.ts", line: 1, severity: "Blocking", message: "title" },
      { path: "c.ts", line: 1, severity: "critical", message: "synonym" },
      { path: "d.ts", line: 1, severity: "NIT", message: "upper nit" },
    ],
  };
  const result = normalizeVerdict(raw);
  assert.equal(result.findings.length, 4);
  assert.equal(result.findings[0]?.severity, "blocking");
  assert.equal(result.findings[1]?.severity, "blocking");
  assert.equal(result.findings[2]?.severity, "blocking"); // "critical" → blocking
  assert.equal(result.findings[3]?.severity, "nit");
});

test("normalizeVerdict accepts string-numeric or L-prefixed line numbers", () => {
  const raw = {
    walkthrough: "x",
    verdict: "request_changes",
    findings: [
      { path: "a.ts", line: "42", severity: "blocking", message: "string number" },
      { path: "b.ts", line: "L107", severity: "nit", message: "L-prefix" },
    ],
  };
  const result = normalizeVerdict(raw);
  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0]?.line, 42);
  assert.equal(result.findings[1]?.line, 107);
});

test("normalizeVerdict accepts verdict synonyms and case variations", () => {
  // "LGTM" → approve
  assert.equal(normalizeVerdict({ walkthrough: "x", verdict: "LGTM", findings: [] }).verdict, "approve");
  // "changes_requested" → request_changes (when blocking findings exist)
  assert.equal(
    normalizeVerdict({
      walkthrough: "x",
      verdict: "CHANGES_REQUESTED",
      findings: [{ path: "a.ts", line: 1, severity: "blocking", message: "bug" }],
    }).verdict,
    "request_changes",
  );
  // "reject" → request_changes
  assert.equal(
    normalizeVerdict({
      walkthrough: "x",
      verdict: "reject",
      findings: [{ path: "a.ts", line: 1, severity: "blocking", message: "bug" }],
    }).verdict,
    "request_changes",
  );
  // Non-binary verdicts are rejected so the corrective retry can demand
  // an explicit deploy decision.
  assert.throws(
    () => normalizeVerdict({ walkthrough: "x", verdict: "observation", findings: [] }),
    /explicit binary verdict/i,
  );
});

test("normalizeVerdict accepts alternate field names (file, description, fix)", () => {
  const raw = {
    overview: "Fallback walkthrough field",
    findings: [
      {
        file: "src/foo.ts",           // "file" instead of "path"
        line: 10,
        severity: "blocking",
        description: "wrong",          // "description" instead of "message"
        fix: "if (x) return;",         // "fix" instead of "suggestion"
      },
    ],
    verdict: "request_changes",
  };
  const result = normalizeVerdict(raw);
  assert.equal(result.walkthrough, "Fallback walkthrough field");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.path, "src/foo.ts");
  assert.equal(result.findings[0]?.message, "wrong");
  assert.equal(result.findings[0]?.suggestion, "if (x) return;");
});

test("normalizeVerdict drops findings that are missing path, line, severity, or message", () => {
  const raw = {
    walkthrough: "Walkthrough.",
    findings: [
      { path: "a.ts", line: 1, severity: "blocking", message: "valid" },
      { path: "b.ts", severity: "nit", message: "missing line" },            // invalid
      { line: 10, severity: "blocking", message: "missing path" },           // invalid
      { path: "c.ts", line: 5, message: "missing severity" },                 // invalid
      { path: "d.ts", line: 5, severity: "nit" },                             // missing message
    ],
    verdict: "approve",
  };
  const result = normalizeVerdict(raw);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.path, "a.ts");
});
