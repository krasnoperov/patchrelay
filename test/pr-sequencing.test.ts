import assert from "node:assert/strict";
import test from "node:test";
import {
  detectStackingTarget,
  type GitProbe,
  type SequenceCandidate,
} from "../src/pr-sequencing.ts";

function makeProbe(ancestors: string[], mergeBases: Record<string, string> = {}): GitProbe {
  const relationships = new Set(ancestors);
  return {
    async mergeBase(leftSha, rightSha) {
      return mergeBases[`${leftSha}|${rightSha}`] ?? leftSha;
    },
    async isAncestor(ancestorSha, descendantSha) {
      return ancestorSha === descendantSha || relationships.has(`${ancestorSha}|${descendantSha}`);
    },
  };
}

test("opens against main when there are no in-flight PRs", async () => {
  const result = await detectStackingTarget({
    self: { branch: "feature", headSha: "self", baseRef: "origin/main" },
    candidates: [],
    git: makeProbe([]),
  });

  assert.deepEqual(result, {
    recommendation: "open_pr_against_main",
    reason: "all history shared with other open PRs is already present in origin/main",
  });
});

test("does not turn a conflicting independent PR into a stack", async () => {
  const candidates: SequenceCandidate[] = [
    { prNumber: 1028, branch: "oauth-grants", headSha: "blocked-head" },
  ];

  const result = await detectStackingTarget({
    self: { branch: "activation", headSha: "independent-head", baseRef: "origin/main" },
    candidates,
    git: makeProbe(["main|origin/main"], { "blocked-head|independent-head": "main" }),
  });

  assert.equal(result.recommendation, "open_pr_against_main");
});

test("does not block a parent because another open PR is its strict descendant", async () => {
  const result = await detectStackingTarget({
    self: { branch: "parent", headSha: "parent-head", baseRef: "origin/main" },
    candidates: [{ prNumber: 1030, branch: "child", headSha: "child-head" }],
    git: makeProbe(["parent-head|child-head"]),
  });

  assert.equal(result.recommendation, "open_pr_against_main");
});

test("blocks publication when the branch shares unlanded history with another open PR", async () => {
  const candidates: SequenceCandidate[] = [
    { prNumber: 1028, branch: "oauth-grants", headSha: "blocked-head" },
  ];

  const result = await detectStackingTarget({
    self: { branch: "activation", headSha: "stacked-head", baseRef: "origin/main" },
    candidates,
    git: makeProbe([], { "blocked-head|stacked-head": "shared-unlanded" }),
  });

  assert.equal(result.recommendation, "blocked_open_pr_ancestry");
  if (result.recommendation === "blocked_open_pr_ancestry") {
    assert.deepEqual(result.blockingPrs, [{
      prNumber: 1028,
      branch: "oauth-grants",
      headSha: "blocked-head",
      sharedAncestorSha: "shared-unlanded",
    }]);
    assert.match(result.reason, /#1028/);
    assert.match(result.reason, /origin\/main/);
  }
});

test("reports every shared unlanded ancestry and excludes the current branch", async () => {
  const candidates: SequenceCandidate[] = [
    { prNumber: 1028, branch: "parent-a", headSha: "head-a" },
    { prNumber: 1029, branch: "parent-b", headSha: "head-b" },
    { prNumber: 1030, branch: "activation", headSha: "stacked-head" },
  ];

  const result = await detectStackingTarget({
    self: { branch: "activation", headSha: "stacked-head", baseRef: "origin/main" },
    candidates,
    git: makeProbe([], {
      "head-a|stacked-head": "shared-a",
      "head-b|stacked-head": "shared-b",
    }),
  });

  assert.equal(result.recommendation, "blocked_open_pr_ancestry");
  if (result.recommendation === "blocked_open_pr_ancestry") {
    assert.deepEqual(result.blockingPrs.map((candidate) => candidate.prNumber), [1028, 1029]);
  }
});

test("blocks a duplicate open PR that points at the exact same head", async () => {
  const result = await detectStackingTarget({
    self: { branch: "activation", headSha: "shared-head", baseRef: "origin/main" },
    candidates: [{ prNumber: 1028, branch: "other-branch", headSha: "shared-head" }],
    git: makeProbe([], { "shared-head|shared-head": "shared-head" }),
  });

  assert.equal(result.recommendation, "blocked_open_pr_ancestry");
});
