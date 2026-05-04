import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../src/db/sqlite-store.ts";
import {
  type ChangeIdentity,
  DEFAULT_NO_CACHE_LABEL,
  lookupCarryForwardCandidate,
  republishCarryForward,
  resolveNoCacheLabel,
  resolveReviewSurfaceMode,
  tryCarryForward,
} from "../src/carry-forward.ts";
import type {
  PullRequestSummary,
  ReviewQuillRepositoryConfig,
} from "../src/types.ts";

function makeRepo(overrides: Partial<ReviewQuillRepositoryConfig> = {}): ReviewQuillRepositoryConfig {
  return {
    repoId: "fixture",
    repoFullName: "fixture/repo",
    baseBranch: "main",
    waitForGreenChecks: false,
    requiredChecks: [],
    excludeBranches: [],
    reviewDocs: [],
    diffIgnore: [],
    diffSummarizeOnly: [],
    patchBodyBudgetTokens: 5_000,
    ...overrides,
  };
}

function makePr(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 7,
    title: "Test PR",
    url: "https://github.com/fixture/repo/pull/7",
    state: "OPEN",
    isDraft: false,
    headSha: "newhead",
    headRefName: "feature/x",
    baseRefName: "main",
    labels: [],
    ...overrides,
  };
}

const silentLogger = {
  info() {},
  warn() {},
  debug() {},
  error() {},
  child() { return silentLogger; },
} as never;

test("resolveReviewSurfaceMode defaults to head", () => {
  assert.equal(resolveReviewSurfaceMode(makeRepo()), "head");
});

test("resolveReviewSurfaceMode honors integration_tree override", () => {
  assert.equal(resolveReviewSurfaceMode(makeRepo({ reviewSurfaceMode: "integration_tree" })), "integration_tree");
});

test("resolveNoCacheLabel uses the documented default", () => {
  assert.equal(resolveNoCacheLabel(makeRepo()), DEFAULT_NO_CACHE_LABEL);
  assert.equal(DEFAULT_NO_CACHE_LABEL, "review:no-cache");
});

test("resolveNoCacheLabel honors a project override", () => {
  assert.equal(resolveNoCacheLabel(makeRepo({ noCacheLabel: "skip-cache" })), "skip-cache");
});

test("findApprovedAttemptByPatchId returns rows with stored body and event", () => {
  const store = new SqliteStore(":memory:");
  // Old-shape row with no body (rollout-safety: never serves carry-forward).
  store.createAttempt({
    repoFullName: "fixture/repo",
    prNumber: 7,
    headSha: "old1",
    status: "completed",
    conclusion: "approved",
    patchId: "patch-A",
    reviewSurfaceMode: "head",
  });
  // New-shape row with a stored body — eligible for carry-forward.
  const cached = store.createAttempt({
    repoFullName: "fixture/repo",
    prNumber: 7,
    headSha: "old2",
    status: "completed",
    conclusion: "approved",
    patchId: "patch-A",
    reviewSurfaceMode: "head",
    reviewBody: "Approved by review-quill",
    reviewEvent: "APPROVE",
    publicationMode: "body_only",
  });

  const found = store.findApprovedAttemptByPatchId("fixture/repo", 7, "patch-A", "head");
  assert.ok(found);
  assert.equal(found?.id, cached.id);
  assert.equal(found?.reviewBody, "Approved by review-quill");

  // A different patch-id finds nothing.
  assert.equal(store.findApprovedAttemptByPatchId("fixture/repo", 7, "patch-B", "head"), undefined);

  // Mode mismatch is filtered out.
  assert.equal(store.findApprovedAttemptByPatchId("fixture/repo", 7, "patch-A", "integration_tree"), undefined);

  store.close();
});

test("findApprovedAttemptByPatchAndTree filters on both keys", () => {
  const store = new SqliteStore(":memory:");
  store.createAttempt({
    repoFullName: "fixture/repo",
    prNumber: 7,
    headSha: "h1",
    status: "completed",
    conclusion: "approved",
    patchId: "P",
    integrationTreeId: "T1",
    reviewSurfaceMode: "integration_tree",
    reviewBody: "ok",
    reviewEvent: "APPROVE",
    publicationMode: "body_only",
  });
  const exact = store.findApprovedAttemptByPatchAndTree("fixture/repo", 7, "P", "T1", "integration_tree");
  assert.ok(exact);
  assert.equal(store.findApprovedAttemptByPatchAndTree("fixture/repo", 7, "P", "T2", "integration_tree"), undefined);
  store.close();
});

test("findApprovedAttemptByPatchId ignores declined and failed attempts", () => {
  const store = new SqliteStore(":memory:");
  store.createAttempt({
    repoFullName: "fixture/repo",
    prNumber: 7,
    headSha: "h1",
    status: "completed",
    conclusion: "declined",
    patchId: "P",
    reviewSurfaceMode: "head",
    reviewBody: "Changes requested",
    reviewEvent: "REQUEST_CHANGES",
    publicationMode: "body_only",
  });
  store.createAttempt({
    repoFullName: "fixture/repo",
    prNumber: 7,
    headSha: "h2",
    status: "failed",
    conclusion: "error",
    patchId: "P",
    reviewSurfaceMode: "head",
    reviewBody: "(should be ignored)",
    reviewEvent: "COMMENT",
    publicationMode: "body_only",
  });

  assert.equal(store.findApprovedAttemptByPatchId("fixture/repo", 7, "P", "head"), undefined);
  store.close();
});

test("tryCarryForward skips PRs with the no-cache label and never touches GitHub", async () => {
  const store = new SqliteStore(":memory:");
  let submitCalled = false;
  const github = {
    currentTokenForRepo: () => "tok",
    submitReview: async () => { submitCalled = true; },
  } as never;

  const result = await tryCarryForward(
    makeRepo(),
    makePr({ labels: ["review:no-cache"] }),
    { store, github, logger: silentLogger },
  );
  assert.equal(result.kind, "skipped");
  if (result.kind === "skipped") {
    assert.equal(result.reason, "no_cache_label");
  }
  assert.equal(submitCalled, false);
  store.close();
});

test("lookupCarryForwardCandidate dispatches by review surface mode", () => {
  const store = new SqliteStore(":memory:");
  store.createAttempt({
    repoFullName: "fixture/repo",
    prNumber: 7,
    headSha: "h1",
    status: "completed",
    conclusion: "approved",
    patchId: "P",
    reviewSurfaceMode: "head",
    reviewBody: "ok",
    reviewEvent: "APPROVE",
    publicationMode: "body_only",
  });
  const head = lookupCarryForwardCandidate(
    makeRepo(),
    7,
    { patchId: "P", baseSha: "B", mode: "head" },
    store,
  );
  assert.ok(head);

  // integration_tree mode without a tree id never finds anything (v1
  // never populates integration_tree_id, so this branch is permanently
  // unreachable until §3.4 ships).
  const treeNoId = lookupCarryForwardCandidate(
    makeRepo(),
    7,
    { patchId: "P", baseSha: "B", mode: "integration_tree" },
    store,
  );
  assert.equal(treeNoId, undefined);
  store.close();
});

test("republishCarryForward submits a fresh review and inserts a linked attempt", async () => {
  const store = new SqliteStore(":memory:");
  const prior = store.createAttempt({
    repoFullName: "fixture/repo",
    prNumber: 7,
    headSha: "old-head",
    status: "completed",
    conclusion: "approved",
    patchId: "P",
    reviewSurfaceMode: "head",
    baseSha: "B",
    reviewBody: "Approved by review-quill",
    reviewEvent: "APPROVE",
    publicationMode: "body_only",
  });

  const submitted: Array<Record<string, unknown>> = [];
  const github = {
    submitReview: async (
      repo: string,
      prNumber: number,
      params: Record<string, unknown>,
    ) => {
      submitted.push({ repo, prNumber, ...params });
    },
  } as never;

  const identity: ChangeIdentity = {
    patchId: "P",
    baseSha: "newer-base",
    mode: "head",
  };
  const inserted = await republishCarryForward(
    makeRepo(),
    makePr({ headSha: "new-head" }),
    prior,
    identity,
    { store, github, logger: silentLogger },
  );

  // GitHub got exactly one submitReview call, on the NEW head SHA, with
  // the prior body+event.
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]?.commitId, "new-head");
  assert.equal(submitted[0]?.event, "APPROVE");
  assert.equal(submitted[0]?.body, "Approved by review-quill");

  // The new attempt row links back to the prior and carries forward
  // body/event/mode/baseSha so it can serve the next head too.
  assert.equal(inserted.headSha, "new-head");
  assert.equal(inserted.priorAttemptId, prior.id);
  assert.equal(inserted.status, "completed");
  assert.equal(inserted.conclusion, "approved");
  assert.equal(inserted.patchId, "P");
  assert.equal(inserted.reviewBody, "Approved by review-quill");
  assert.equal(inserted.reviewEvent, "APPROVE");
  assert.equal(inserted.reviewSurfaceMode, "head");
  assert.equal(inserted.baseSha, "newer-base");
  assert.equal(inserted.publicationMode, "body_only");

  // Subsequent lookups now find this row too — the cache populates
  // through carry-forward chains.
  const found = store.findApprovedAttemptByPatchId("fixture/repo", 7, "P", "head");
  assert.equal(found?.id, inserted.id);
  store.close();
});

test("republishCarryForward refuses to act on a candidate missing body or event", async () => {
  const store = new SqliteStore(":memory:");
  // Old-shape row from before the migration — no reviewBody / reviewEvent.
  const stale = store.createAttempt({
    repoFullName: "fixture/repo",
    prNumber: 7,
    headSha: "old-head",
    status: "completed",
    conclusion: "approved",
    patchId: "P",
    reviewSurfaceMode: "head",
  });

  const github = {
    submitReview: async () => assert.fail("submitReview should not be called"),
  } as never;

  await assert.rejects(
    () => republishCarryForward(
      makeRepo(),
      makePr({ headSha: "new-head" }),
      stale,
      { patchId: "P", baseSha: "B", mode: "head" },
      { store, github, logger: silentLogger },
    ),
    /requires reviewBody and reviewEvent/,
  );
  store.close();
});

test("tryCarryForward skips stacked PRs (parent-base resolution deferred)", async () => {
  const store = new SqliteStore(":memory:");
  const github = {
    currentTokenForRepo: () => "tok",
    submitReview: async () => assert.fail("should not be called for stacked PR"),
  } as never;

  const result = await tryCarryForward(
    makeRepo({ baseBranch: "main" }),
    makePr({ baseRefName: "feature/parent" }),
    { store, github, logger: silentLogger },
  );
  // Stacked PRs return identity_unavailable in v1 because we cannot
  // safely compute patch_id against the parent without fetching that ref.
  assert.equal(result.kind, "skipped");
  if (result.kind === "skipped") {
    assert.equal(result.reason, "identity_unavailable");
  }
  store.close();
});
