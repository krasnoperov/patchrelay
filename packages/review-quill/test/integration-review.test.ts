import assert from "node:assert/strict";
import test from "node:test";
import {
  findFrozenApprovedHead,
  hasIntegrationCheck,
  parseIntegrationCandidateRef,
  selectIntegrationReviewCandidate,
} from "../src/integration-review.ts";

test("candidate refs are self-describing and support slash-containing base branches", () => {
  assert.deepEqual(parseIntegrationCandidateRef({
    ref: "refs/heads/merge-steward/release/next/pr-104",
    sha: "candidate",
  }), {
    ref: "refs/heads/merge-steward/release/next/pr-104",
    baseBranch: "release/next",
    prNumber: 104,
    candidateSha: "candidate",
  });
  assert.equal(parseIntegrationCandidateRef({ ref: "refs/heads/mq-spec-3", sha: "old" }), undefined);
});

test("any approval on the exact feature head freezes the integration baseline", () => {
  assert.equal(findFrozenApprovedHead([
    { id: 1, state: "APPROVED", commitId: "approved-head", authorLogin: "krasnoperov" },
    { id: 2, state: "CHANGES_REQUESTED", commitId: "approved-head", authorLogin: "another-reviewer" },
  ], "approved-head"), "approved-head");
  assert.equal(findFrozenApprovedHead([
    { id: 1, state: "APPROVED", commitId: "old-head", authorLogin: "krasnoperov" },
  ], "current-head"), undefined);
});

test("only decisive or in-progress integration checks suppress another review", () => {
  assert.equal(hasIntegrationCheck([{ id: 1, name: "review-quill/integration", status: "completed", conclusion: "neutral" }]), false);
  assert.equal(hasIntegrationCheck([{ id: 2, name: "review-quill/integration", status: "in_progress" }]), true);
  assert.equal(hasIntegrationCheck([{ id: 3, name: "review-quill/integration", status: "completed", conclusion: "success" }]), true);
});

test("repaired candidate is eligible only after it contains approved head and PatchRelay authored its tip", async () => {
  const calls: string[] = [];
  const github = {
    listPullRequestReviews: async () => [{
      id: 1,
      state: "APPROVED",
      commitId: "approved-head",
      authorLogin: "krasnoperov",
    }],
    isAncestor: async (_repo: string, ancestor: string, descendant: string) => {
      calls.push(`${ancestor}:${descendant}`);
      return true;
    },
    listCheckRuns: async () => [],
    getCommit: async () => ({
      sha: "candidate",
      message: "Resolve integration conflict",
      parentShas: ["prospective-base", "approved-head"],
      authorLogin: "patchrelay[bot]",
    }),
  };
  const selected = await selectIntegrationReviewCandidate({
    github: github as never,
    repoFullName: "owner/repo",
    pr: {
      number: 104,
      title: "Feature",
      url: "url",
      state: "OPEN",
      isDraft: false,
      headSha: "approved-head",
      headRefName: "feature",
      baseRefName: "main",
      baseSha: "main",
      labels: [],
    },
    candidate: {
      ref: "refs/heads/merge-steward/main/pr-104",
      baseBranch: "main",
      prNumber: 104,
      candidateSha: "candidate",
    },
    reviewerLogin: "review-quill",
  });
  assert.equal(selected?.prospectiveBaseSha, "prospective-base");
  assert.deepEqual(calls, ["approved-head:candidate"]);

  github.getCommit = async () => ({
    sha: "candidate",
    message: "Merge PR #104",
    parentShas: ["prospective-base", "approved-head"],
    authorLogin: "merge-steward[bot]",
  });
  assert.equal(await selectIntegrationReviewCandidate({
    github: github as never,
    repoFullName: "owner/repo",
    pr: {
      number: 104, title: "Feature", url: "url", state: "OPEN", isDraft: false,
      headSha: "approved-head", headRefName: "feature", baseRefName: "main", baseSha: "main", labels: [],
    },
    candidate: {
      ref: "refs/heads/merge-steward/main/pr-104", baseBranch: "main", prNumber: 104, candidateSha: "candidate",
    },
    reviewerLogin: "review-quill",
  }), undefined);
});

test("test-repair commits recover the prospective base from the underlying integration merge", async () => {
  const github = {
    listPullRequestReviews: async () => [{
      id: 1, state: "APPROVED", commitId: "approved-head", authorLogin: "review-quill[bot]",
    }],
    isAncestor: async () => true,
    listCheckRuns: async () => [],
    getCommit: async (_repo: string, sha: string) => sha === "repair-tip"
      ? { sha, message: "Fix integration test", parentShas: ["merge-candidate"], authorLogin: "patchrelay[bot]" }
      : { sha, message: "Merge PR #104", parentShas: ["prospective-base", "approved-head"], authorLogin: "merge-steward[bot]" },
  };
  const selected = await selectIntegrationReviewCandidate({
    github: github as never,
    repoFullName: "owner/repo",
    pr: {
      number: 104, title: "Feature", url: "url", state: "OPEN", isDraft: false,
      headSha: "approved-head", headRefName: "feature", baseRefName: "main", baseSha: "main", labels: [],
    },
    candidate: {
      ref: "refs/heads/merge-steward/main/pr-104", baseBranch: "main", prNumber: 104, candidateSha: "repair-tip",
    },
    reviewerLogin: "review-quill",
  });
  assert.equal(selected?.prospectiveBaseSha, "prospective-base");
});
