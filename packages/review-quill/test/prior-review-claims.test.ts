import assert from "node:assert/strict";
import test from "node:test";
import { buildPriorReviewClaims } from "../src/prompt-context/github-context.ts";
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
