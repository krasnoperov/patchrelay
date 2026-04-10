import assert from "node:assert/strict";
import test from "node:test";
import { evaluateReviewEligibility } from "../src/review-eligibility.ts";

test("evaluateReviewEligibility rejects drafts and missing heads", async () => {
  const github = {
    listCheckRuns: async () => [],
  };
  assert.deepEqual(
    await evaluateReviewEligibility({
      repo: { repoFullName: "owner/repo", requiredChecks: [], excludeBranches: [] } as never,
      github,
      headSha: "",
      isDraft: false,
      branchName: "main",
    }),
    { eligible: false, reason: "missing_head_sha" },
  );
  assert.deepEqual(
    await evaluateReviewEligibility({
      repo: { repoFullName: "owner/repo", requiredChecks: [], excludeBranches: [] } as never,
      github,
      headSha: "sha",
      isDraft: true,
      branchName: "main",
    }),
    { eligible: false, reason: "draft" },
  );
});

test("evaluateReviewEligibility accepts green required checks", async () => {
  const result = await evaluateReviewEligibility({
    repo: { repoFullName: "owner/repo", requiredChecks: ["Tests"], excludeBranches: [] } as never,
    github: {
      listCheckRuns: async () => [{ name: "Tests", status: "completed", conclusion: "success" }],
    },
    headSha: "sha",
    isDraft: false,
    branchName: "feature/x",
  });
  assert.deepEqual(result, { eligible: true });
});
