import assert from "node:assert/strict";
import test from "node:test";
import { summarizeReviewBody } from "../src/prompt-context/github-context.ts";

test("summarizeReviewBody returns undefined for empty input", () => {
  assert.equal(summarizeReviewBody(undefined), undefined);
  assert.equal(summarizeReviewBody(""), undefined);
  assert.equal(summarizeReviewBody("\n\n   \n"), undefined);
});

test("summarizeReviewBody returns normalized body when within the limit", () => {
  const body = "Line one.\n\nLine two.\nLine three.";
  assert.equal(summarizeReviewBody(body), "Line one. Line two. Line three.");
});

test("summarizeReviewBody preserves the verdict line when the body exceeds the limit", () => {
  const filler = "Detailed walkthrough that describes the PR in substantial depth. ".repeat(40);
  const body = `${filler}\n\n**Verdict: 🛑 Request changes** — The skip heuristic cannot distinguish a partial install from a healthy one.`;
  const excerpt = summarizeReviewBody(body);
  assert.ok(excerpt, "expected an excerpt");
  assert.ok(
    excerpt.includes("**Verdict: 🛑 Request changes** — The skip heuristic cannot distinguish a partial install from a healthy one."),
    `verdict line missing from excerpt: ${excerpt}`,
  );
  assert.ok(excerpt.length <= 1500, `excerpt longer than cap: ${excerpt.length}`);
});

test("summarizeReviewBody truncates prose but still ends on the verdict line", () => {
  const filler = "x".repeat(5000);
  const body = `${filler}\n**Verdict: ✅ Approve** — Clean fix.`;
  const excerpt = summarizeReviewBody(body);
  assert.ok(excerpt?.endsWith("**Verdict: ✅ Approve** — Clean fix."), `excerpt should end with verdict: ${excerpt}`);
  assert.ok((excerpt?.length ?? 0) <= 1500);
});

test("summarizeReviewBody falls back to plain truncation when no verdict line is present", () => {
  const body = "a".repeat(2000);
  const excerpt = summarizeReviewBody(body);
  assert.ok(excerpt?.endsWith("..."));
  assert.equal(excerpt?.length, 1500);
});
