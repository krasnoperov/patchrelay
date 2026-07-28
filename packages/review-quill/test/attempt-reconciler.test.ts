import assert from "node:assert/strict";
import test from "node:test";
import { AttemptReconciler } from "../src/attempt-reconciler.ts";

const silentLogger = {
  info() {},
  warn() {},
  debug() {},
  error() {},
  child() { return silentLogger; },
} as never;

test("base change dismissal removes Review Quill's decisive review from the current head", async () => {
  const dismissed: Array<{ id: number; message: string }> = [];
  const reconciler = new AttemptReconciler({
    store: {} as never,
    github: {
      dismissReview: async (
        _repo: string,
        _prNumber: number,
        id: number,
        message: string,
      ) => {
        dismissed.push({ id, message });
      },
    } as never,
    logger: silentLogger,
    config: {} as never,
    serviceStartedAt: new Date().toISOString(),
    reviewerLogin: "review-quill",
  });

  await reconciler.dismissStaleDecisiveReviews(
    { repoFullName: "fixture/repo" } as never,
    { number: 7, headSha: "same-head" } as never,
    [
      { id: 10, authorLogin: "review-quill[bot]", state: "APPROVED", commitId: "same-head" },
      { id: 11, authorLogin: "human", state: "APPROVED", commitId: "same-head" },
    ],
    { invalidateCurrentHead: true },
  );

  assert.deepEqual(dismissed.map((item) => item.id), [10]);
  assert.match(dismissed[0]?.message ?? "", /base changed/);
});

test("base change dismissal fails closed when GitHub cannot invalidate the current approval", async () => {
  const reconciler = new AttemptReconciler({
    store: {} as never,
    github: {
      dismissReview: async () => {
        throw new Error("GitHub 503");
      },
    } as never,
    logger: silentLogger,
    config: {} as never,
    serviceStartedAt: new Date().toISOString(),
    reviewerLogin: "review-quill",
  });

  await assert.rejects(
    reconciler.dismissStaleDecisiveReviews(
      { repoFullName: "fixture/repo" } as never,
      { number: 7, headSha: "same-head" } as never,
      [{ id: 10, authorLogin: "review-quill", state: "APPROVED", commitId: "same-head" }],
      { invalidateCurrentHead: true },
    ),
    /Could not invalidate Review Quill approval 10.*GitHub 503/,
  );
});
