import assert from "node:assert/strict";
import test from "node:test";
import { hasMatchingLatestReviewForHead } from "../src/service.ts";

test("hasMatchingLatestReviewForHead skips resubmission when latest reviewer verdict already matches the head", () => {
  const reviews = [
    {
      id: 1,
      authorLogin: "review-quill",
      state: "CHANGES_REQUESTED",
      commitId: "older-sha",
    },
    {
      id: 2,
      authorLogin: "review-quill",
      state: "APPROVED",
      commitId: "head-sha",
    },
  ];

  assert.equal(hasMatchingLatestReviewForHead(reviews, "review-quill", "head-sha", "approve"), true);
  assert.equal(hasMatchingLatestReviewForHead(reviews, "review-quill", "head-sha", "request_changes"), false);
  assert.equal(hasMatchingLatestReviewForHead(reviews, "someone-else", "head-sha", "approve"), false);
});
