import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFollowUpHumanClaims,
  buildGitHubPromptContext,
  buildPriorReviewClaims,
} from "../src/prompt-context/github-context.ts";
import type { PullRequestReviewRecord } from "../src/types.ts";

function review(overrides: Partial<PullRequestReviewRecord>): PullRequestReviewRecord {
  return {
    id: 0,
    authorLogin: "review-quill",
    state: "CHANGES_REQUESTED",
    commitId: "deadbeef",
    body: "**Verdict: 🛑 Request changes** — Something is wrong.",
    ...overrides,
  } as PullRequestReviewRecord;
}

test("buildPriorReviewClaims keeps only the latest same-author claim below the fresh-start threshold", () => {
  const reviews = [
    review({ id: 1, body: "**Verdict: 🛑 Request changes** — First concern." }),
    review({ id: 2, body: "**Verdict: 🛑 Request changes** — Second concern." }),
  ];
  const claims = buildPriorReviewClaims(reviews, "review-quill");
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.excerpt, "**Verdict: 🛑 Request changes** — Second concern.");
});

test("buildPriorReviewClaims drops the bot's own claims once 3 decisive reviews accumulate (fresh-start)", () => {
  const reviews = [
    review({ id: 1, body: "**Verdict: 🛑 Request changes** — First." }),
    review({ id: 2, body: "**Verdict: 🛑 Request changes** — Second." }),
    review({ id: 3, body: "**Verdict: 🛑 Request changes** — Third." }),
  ];
  const claims = buildPriorReviewClaims(reviews, "review-quill");
  assert.equal(claims.length, 0, `expected empty claims after fresh-start threshold, got ${JSON.stringify(claims)}`);
});

test("buildPriorReviewClaims keeps human reviewer claims even after bot fresh-start", () => {
  const reviews = [
    review({ id: 1, authorLogin: "review-quill", body: "**Verdict: 🛑 Request changes** — Bot first." }),
    review({ id: 2, authorLogin: "review-quill", body: "**Verdict: 🛑 Request changes** — Bot second." }),
    review({ id: 3, authorLogin: "review-quill", body: "**Verdict: 🛑 Request changes** — Bot third." }),
    review({ id: 4, authorLogin: "alice", body: "**Verdict: 🛑 Request changes** — Human reviewer says fix X." }),
  ];
  const claims = buildPriorReviewClaims(reviews, "review-quill");
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.authorLogin, "alice");
  assert.ok(claims[0]?.excerpt.includes("Human reviewer"));
});

test("buildPriorReviewClaims keeps one self claim plus newer human claims within the cap", () => {
  const reviews = [
    review({ id: 1, authorLogin: "review-quill", body: "**Verdict: 🛑 Request changes** — Bot concern." }),
    review({ id: 2, authorLogin: "alice", body: "**Verdict: 🛑 Request changes** — Human blocker A." }),
    review({ id: 3, authorLogin: "bob", state: "COMMENTED", body: "**Verdict: 💬 Comment** — Human note." }),
    review({ id: 4, authorLogin: "carol", body: "**Verdict: 🛑 Request changes** — Human blocker B." }),
  ];
  const claims = buildPriorReviewClaims(reviews, "review-quill");
  assert.equal(claims.length, 3);
  assert.equal(claims[0]?.authorLogin, "review-quill");
  assert.equal(claims[0]?.excerpt, "**Verdict: 🛑 Request changes** — Bot concern.");
  assert.equal(claims[1]?.authorLogin, "carol");
  assert.equal(claims[2]?.authorLogin, "alice");
});

test("buildPriorReviewClaims tolerates [bot] suffix on selfLogin (github apps)", () => {
  const reviews = [
    review({ id: 1, authorLogin: "review-quill[bot]", body: "**Verdict: 🛑 Request changes** — One." }),
    review({ id: 2, authorLogin: "review-quill[bot]", body: "**Verdict: 🛑 Request changes** — Two." }),
    review({ id: 3, authorLogin: "review-quill[bot]", body: "**Verdict: 🛑 Request changes** — Three." }),
  ];
  const claims = buildPriorReviewClaims(reviews, "review-quill");
  assert.equal(claims.length, 0, "bot suffix should match so fresh-start still triggers");
});

test("buildPriorReviewClaims without selfLogin falls back to the legacy behavior", () => {
  const reviews = [
    review({ id: 1, body: "**Verdict: 🛑 Request changes** — One." }),
    review({ id: 2, body: "**Verdict: 🛑 Request changes** — Two." }),
    review({ id: 3, body: "**Verdict: 🛑 Request changes** — Three." }),
    review({ id: 4, body: "**Verdict: 🛑 Request changes** — Four." }),
  ];
  const claims = buildPriorReviewClaims(reviews);
  // Legacy: sorted by decisive-first then newest, capped at 3. No fresh-start.
  assert.equal(claims.length, 3);
});

test("buildPriorReviewClaims only counts decisive reviews toward the fresh-start threshold", () => {
  const reviews = [
    review({ id: 1, state: "COMMENTED", body: "**Verdict: 💬 Comment** — Non-blocking nit 1." }),
    review({ id: 2, state: "COMMENTED", body: "**Verdict: 💬 Comment** — Non-blocking nit 2." }),
    review({ id: 3, body: "**Verdict: 🛑 Request changes** — Real concern." }),
  ];
  const claims = buildPriorReviewClaims(reviews, "review-quill");
  // Only 1 decisive same-author review; fresh-start must NOT trigger.
  // We still surface only one self-authored claim to avoid ratcheting.
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.excerpt, "**Verdict: 🛑 Request changes** — Real concern.");
});

test("buildFollowUpHumanClaims keeps only newer humans, decisive first then newest, capped at three", () => {
  const claims = buildFollowUpHumanClaims([
    review({ id: 1, authorLogin: "alice", submittedAt: "2026-07-18T09:59:59Z", body: "Before completion" }),
    review({ id: 2, authorLogin: "REVIEW-QUILL[bot]", submittedAt: "2026-07-18T10:01:00Z", body: "Self bot" }),
    review({ id: 3, authorLogin: "review-quill", submittedAt: "2026-07-18T10:02:00Z", body: "Self case" }),
    review({ id: 8, authorLogin: "renovate[bot]", state: "APPROVED", submittedAt: "2026-07-18T10:07:00Z", body: "Other bot" }),
    review({ id: 4, authorLogin: "alice", state: "COMMENTED", submittedAt: "2026-07-18T10:05:00Z", body: "Newest comment" }),
    review({ id: 5, authorLogin: "bob", state: "APPROVED", submittedAt: "2026-07-18T10:03:00Z", body: "Decisive approval" }),
    review({ id: 6, authorLogin: "carol", state: "CHANGES_REQUESTED", submittedAt: "2026-07-18T10:04:00Z", body: "Decisive blocker" }),
    review({ id: 7, authorLogin: "dave", state: "COMMENTED", submittedAt: "2026-07-18T10:06:00Z", body: "Newest extra comment" }),
  ], "Review-Quill", "2026-07-18T10:00:00Z");

  assert.deepEqual(claims.map((claim) => claim.authorLogin), ["carol", "bob", "dave"]);
});

test("buildFollowUpHumanClaims requires reviewer identity and a valid completion timestamp", () => {
  const reviews = [review({ authorLogin: "alice", submittedAt: "2026-07-18T10:01:00Z", body: "Human" })];
  assert.deepEqual(buildFollowUpHumanClaims(reviews, undefined, "2026-07-18T10:00:00Z"), []);
  assert.deepEqual(buildFollowUpHumanClaims(reviews, "review-quill", undefined), []);
  assert.deepEqual(buildFollowUpHumanClaims(reviews, "review-quill", "invalid"), []);
});

test("buildGitHubPromptContext fetches reviews once for full and follow-up claims", async () => {
  let calls = 0;
  const context = await buildGitHubPromptContext({
    listPullRequestReviews: async () => {
      calls += 1;
      return [review({
        authorLogin: "alice",
        submittedAt: "2026-07-18T10:01:00Z",
        body: "New human evidence",
      })];
    },
  } as never, "owner/repo", { number: 7 } as never, "review-quill", "2026-07-18T10:00:00Z");

  assert.equal(calls, 1);
  assert.equal(context.priorReviewClaims.length, 1);
  assert.equal(context.followUpReviewClaims.length, 1);
});
