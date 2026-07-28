import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../src/db/sqlite-store.ts";
import {
  type ChangeIdentity,
  DEFAULT_NO_CACHE_LABEL,
  lookupCarryForwardCandidate,
  republishCarryForward,
  revalidateCarryForwardInput,
  resolveNoCacheLabel,
  tryCarryForward,
} from "../src/carry-forward.ts";
import type { PullRequestSummary, ReviewQuillRepositoryConfig } from "../src/types.ts";
import { buildPromptFingerprint } from "../src/prompt-fingerprint.ts";

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
    headRefName: "feature/child",
    baseRefName: "feature/parent",
    baseSha: "parent-sha",
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

test("resolveNoCacheLabel uses the documented default and project override", () => {
  assert.equal(resolveNoCacheLabel(makeRepo()), DEFAULT_NO_CACHE_LABEL);
  assert.equal(DEFAULT_NO_CACHE_LABEL, "review:no-cache");
  assert.equal(resolveNoCacheLabel(makeRepo({ noCacheLabel: "skip-cache" })), "skip-cache");
});

test("carry-forward lookup requires an approved stored verdict and matching prompt", () => {
  const store = new SqliteStore(":memory:");
  const promptFingerprint = buildPromptFingerprint(makePr());
  store.createAttempt({
    repoFullName: "fixture/repo",
    prNumber: 7,
    headSha: "old1",
    status: "completed",
    conclusion: "approved",
    patchId: "patch-A",
    diffBaseSha: "parent-sha",
    promptFingerprint,
  });
  const cached = store.createAttempt({
    repoFullName: "fixture/repo",
    prNumber: 7,
    headSha: "old2",
    status: "completed",
    conclusion: "approved",
    patchId: "patch-A",
    diffBaseSha: "parent-sha",
    promptFingerprint,
    reviewBody: "Approved by review-quill",
    reviewEvent: "APPROVE",
    publicationMode: "body_only",
  });

  const identity = { patchId: "patch-A", prBaseSha: "parent-sha", diffBaseSha: "parent-sha" };
  assert.equal(lookupCarryForwardCandidate(makeRepo(), 7, identity, store, promptFingerprint)?.id, cached.id);
  assert.equal(
    lookupCarryForwardCandidate(
      makeRepo(),
      7,
      { ...identity, prBaseSha: "new-parent", diffBaseSha: "new-parent" },
      store,
      promptFingerprint,
    ),
    undefined,
    "a changed effective base requires a fresh review even when the patch is unchanged",
  );
  assert.equal(
    lookupCarryForwardCandidate(
      makeRepo(),
      7,
      identity,
      store,
      buildPromptFingerprint(makePr({ title: "Changed prompt" })),
    ),
    undefined,
  );
  store.close();
});

test("republishCarryForward publishes on a new head and records both PR and diff bases", async () => {
  const store = new SqliteStore(":memory:");
  const prior = store.createAttempt({
    repoFullName: "fixture/repo",
    prNumber: 7,
    headSha: "old-head",
    status: "completed",
    conclusion: "approved",
    patchId: "P",
    reviewBody: "Approved by review-quill",
    reviewEvent: "APPROVE",
    publicationMode: "body_only",
  });
  const submitted: Array<Record<string, unknown>> = [];
  const github = {
    submitReview: async (repo: string, prNumber: number, params: Record<string, unknown>) => {
      submitted.push({ repo, prNumber, ...params });
    },
  } as never;
  const identity: ChangeIdentity = {
    patchId: "P",
    prBaseSha: "github-parent-sha",
    diffBaseSha: "merge-base-sha",
  };

  const inserted = await republishCarryForward(
    makeRepo(),
    makePr({ headSha: "new-head" }),
    prior,
    identity,
    { store, github, logger: silentLogger },
  );

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]?.commitId, "new-head");
  assert.equal(inserted.priorAttemptId, prior.id);
  assert.equal(inserted.prBaseSha, "github-parent-sha");
  assert.equal(inserted.diffBaseSha, "merge-base-sha");
  store.close();
});

test("republishCarryForward updates a same-head row without duplicating its GitHub review", async () => {
  const store = new SqliteStore(":memory:");
  const prior = store.createAttempt({
    repoFullName: "fixture/repo",
    prNumber: 7,
    headSha: "same-head",
    status: "completed",
    conclusion: "approved",
    patchId: "P",
    reviewBody: "Approved by review-quill",
    reviewEvent: "APPROVE",
  });
  const github = {
    submitReview: async () => assert.fail("same-head carry-forward must not post a duplicate review"),
  } as never;

  const updated = await republishCarryForward(
    makeRepo(),
    makePr({ headSha: "same-head", baseSha: "retargeted-base" }),
    prior,
    { patchId: "P", prBaseSha: "retargeted-base", diffBaseSha: "merge-base" },
    { store, github, logger: silentLogger },
  );

  assert.equal(updated.id, prior.id);
  assert.equal(updated.prBaseSha, "retargeted-base");
  assert.equal(updated.diffBaseSha, "merge-base");
  store.close();
});

test("carry-forward input revalidation rejects a same-head base change", async () => {
  const reviewed = makePr({ headSha: "same-head", baseSha: "old-parent" });
  const github = {
    getPullRequest: async () => makePr({
      headSha: "same-head",
      baseSha: "new-parent",
    }),
  } as never;

  const result = await revalidateCarryForwardInput(
    github,
    "fixture/repo",
    reviewed,
  );

  assert.equal(result.valid, false);
  assert.equal(result.currentPr.baseSha, "new-parent");
});

test("tryCarryForward honors the no-cache label before materializing a workspace", async () => {
  const store = new SqliteStore(":memory:");
  const github = {
    currentTokenForRepo: () => assert.fail("no-cache must short-circuit before token or git access"),
  } as never;

  const result = await tryCarryForward(
    makeRepo(),
    makePr({ labels: ["review:no-cache"] }),
    { store, github, logger: silentLogger },
  );
  assert.deepEqual(result, { kind: "skipped", reason: "no_cache_label" });
  store.close();
});
