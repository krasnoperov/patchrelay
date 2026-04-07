import assert from "node:assert/strict";
import test from "node:test";
import { classifyPublicationDisposition, hasMatchingLatestReviewForHead } from "../src/service.ts";

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

test("classifyPublicationDisposition marks stale heads as superseded", () => {
  const disposition = classifyPublicationDisposition({
    state: "OPEN",
    isDraft: false,
    headSha: "new-head-sha",
  }, "old-head-sha");

  assert.equal(disposition.action, "supersede");
});

test("classifyPublicationDisposition cancels draft or closed PRs", () => {
  assert.equal(classifyPublicationDisposition({
    state: "OPEN",
    isDraft: true,
    headSha: "same-head",
  }, "same-head").action, "cancel");

  assert.equal(classifyPublicationDisposition({
    state: "CLOSED",
    isDraft: false,
    headSha: "same-head",
  }, "same-head").action, "cancel");
});
