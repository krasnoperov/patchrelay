import assert from "node:assert/strict";
import test from "node:test";
import { ReviewQuillService } from "../src/service.ts";
import { CodexCapacityError, CodexCapacityPause } from "../src/codex-capacity.ts";

const USAGE_LIMIT_DETAIL = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), "
  + "visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:23 AM.";

// The `review:no-cache` label keeps discovery on the fresh-review path
// without touching git for carry-forward identity computation.
function openPullRequest() {
  return {
    number: 7,
    title: "Capacity pause fixture",
    url: "https://github.com/krasnoperov/subtitles/pull/7",
    state: "OPEN",
    isDraft: false,
    headSha: "capacity-head",
    headRefName: "feat/capacity",
    baseRefName: "main",
    labels: ["review:no-cache"],
  };
}

function buildCapacityTestHarness(reviewError: () => Error) {
  let storedAttempt: Record<string, unknown> | undefined;
  const updates: Array<Record<string, unknown>> = [];
  const warns: string[] = [];
  let reviewCalls = 0;
  let createCalls = 0;

  const logger = {
    info() {},
    warn(_data: unknown, message?: string) {
      if (message) warns.push(message);
    },
    error() {},
    debug() {},
    child() {
      return this;
    },
  };

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
      listAttempts: () => (storedAttempt ? [storedAttempt] : []),
      listWebhooks: () => [],
      listActiveAttemptsForRepo: () => [],
      listAttemptsForPullRequest: () => (storedAttempt ? [storedAttempt] : []),
      getAttempt: () => storedAttempt,
      createAttempt: (params: Record<string, unknown>) => {
        createCalls += 1;
        storedAttempt = {
          id: 41,
          ...params,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        return storedAttempt;
      },
      updateAttempt: (_id: number, params: Record<string, unknown>) => {
        updates.push(params);
        storedAttempt = { ...storedAttempt, ...params, updatedAt: new Date().toISOString() };
        return storedAttempt;
      },
      setAttemptTitle: () => undefined,
    } as never,
    {
      listOpenPullRequests: async () => [openPullRequest()],
      getPullRequest: async () => openPullRequest(),
      listPullRequestReviews: async () => [],
      listCheckRuns: async () => [{ name: "verify", status: "completed", conclusion: "success" }],
    } as never,
    {
      review: async () => {
        reviewCalls += 1;
        throw reviewError();
      },
    } as never,
    logger as never,
  );

  // Stub workspace materialization — it shells out to git. Everything else
  // in executeReview (attempt bookkeeping, the capacity catch) stays real.
  (service as unknown as { buildContext: unknown }).buildContext = async () => ({
    context: {
      prompt: "Review this PR.",
      workspace: { worktreePath: "/tmp/review-quill-capacity-test" },
      diff: { inventory: [], patches: [], suppressed: [] },
    },
    dispose: async () => {},
  });

  return {
    service,
    counters: {
      get reviewCalls() {
        return reviewCalls;
      },
      get createCalls() {
        return createCalls;
      },
    },
    get storedAttempt() {
      return storedAttempt;
    },
    updates,
    warns,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("capacity failure pauses all reviews, warns once, and is exempt from attempt accounting", async () => {
  const retryAtIso = new Date(Date.now() + 60 * 60_000).toISOString();
  const harness = buildCapacityTestHarness(() => new CodexCapacityError(USAGE_LIMIT_DETAIL, retryAtIso));
  const { service, counters, updates, warns } = harness;

  // Cycle 1: discovery dispatches the review; Codex reports the usage limit.
  await service.triggerReconcile();
  await settle();

  assert.equal(counters.reviewCalls, 1);
  assert.equal(harness.storedAttempt?.status, "cancelled");
  assert.equal(harness.storedAttempt?.conclusion, "skipped");
  assert.match(String(harness.storedAttempt?.summary), /Codex usage limit; review deferred until/);
  // Accounting exemption: the attempt must NEVER be marked failed/error.
  assert.ok(!updates.some((update) => update.status === "failed"));
  assert.ok(!updates.some((update) => update.conclusion === "error"));
  assert.equal(service.getWatchSnapshot().summary.failedAttempts, 0);

  // Exactly one warn for entering the pause.
  const pauseWarns = warns.filter((message) => /Codex usage limit; pausing reviews until/.test(message));
  assert.equal(pauseWarns.length, 1);
  assert.match(pauseWarns[0]!, /pausing reviews until \d{4}-\d{2}-\d{2}T/);

  // The pause deadline is the advertised reset plus at most 60s of jitter.
  const limitedUntil = service.getRuntimeStatus().codexLimitedUntil;
  assert.ok(limitedUntil, "runtime must expose codexLimitedUntil while paused");
  const delta = Date.parse(limitedUntil!) - Date.parse(retryAtIso);
  assert.ok(delta >= 0 && delta <= 60_000, `deadline must be retryAt + ≤60s jitter, got delta ${delta}ms`);

  // Cycles 2 and 3 while paused: no dispatch, no extra warns, silent skips.
  await service.triggerReconcile();
  await settle();
  await service.triggerReconcile();
  await settle();
  assert.equal(counters.reviewCalls, 1, "no review may run while the capacity pause is active");
  assert.equal(
    warns.filter((message) => /Codex usage limit; pausing reviews until/.test(message)).length,
    1,
    "the pause warn must be logged once, not once per PR per cycle",
  );

  // Simulate the deadline passing: swap in an already-expired pause (the
  // production object clears itself once Date.now() crosses the deadline).
  const expired = new CodexCapacityPause(() => 0);
  expired.enter(new CodexCapacityError("expired fixture"), 0);
  (service as unknown as { codexCapacityPause: CodexCapacityPause }).codexCapacityPause = expired;
  assert.equal(service.getRuntimeStatus().codexLimitedUntil, null);

  // Cycle 4 after expiry: the cancelled attempt is retried automatically.
  await service.triggerReconcile();
  await settle();
  assert.equal(counters.reviewCalls, 2, "reviews must resume once the pause deadline passes");
  // It hit the limit again — the pause re-enters and warns once more.
  assert.equal(
    warns.filter((message) => /Codex usage limit; pausing reviews until/.test(message)).length,
    2,
  );
});

test("capacity failure without a parsed reset time pauses for ten minutes from now", async () => {
  const harness = buildCapacityTestHarness(() => new CodexCapacityError("Rate limit exceeded for the model."));
  const { service } = harness;

  const before = Date.now();
  await service.triggerReconcile();
  await settle();
  const after = Date.now();

  const limitedUntil = service.getRuntimeStatus().codexLimitedUntil;
  assert.ok(limitedUntil);
  const untilMs = Date.parse(limitedUntil!);
  assert.ok(untilMs >= before + 10 * 60_000 && untilMs <= after + 10 * 60_000);
});

test("non-capacity review failures still count as failed attempts and do not pause reviews", async () => {
  const harness = buildCapacityTestHarness(() => new Error("Review run produced unparseable output"));
  const { service, counters } = harness;

  await service.triggerReconcile();
  await settle();

  assert.equal(harness.storedAttempt?.status, "failed");
  assert.equal(harness.storedAttempt?.conclusion, "error");
  assert.equal(service.getRuntimeStatus().codexLimitedUntil, null);
  assert.equal(service.getWatchSnapshot().summary.failedAttempts, 1);

  // Not paused — the next cycle retries immediately.
  await service.triggerReconcile();
  await settle();
  assert.equal(counters.reviewCalls, 2);
});
