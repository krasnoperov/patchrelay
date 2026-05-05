import assert from "node:assert/strict";
import test from "node:test";
import {
  detectStackingTarget,
  type GitProbe,
  type SequenceCandidate,
} from "../src/pr-sequencing.ts";

interface ProbeFixture {
  files: Record<string, string[]>;
  conflicts: Record<string, boolean>;
}

function makeProbe(fixture: ProbeFixture): GitProbe {
  return {
    async changedFiles(_baseRef, headSha) {
      return fixture.files[headSha] ?? [];
    },
    async hasConflict(headSha, candidateHead) {
      return Boolean(fixture.conflicts[`${headSha}|${candidateHead}`]);
    },
  };
}

test("returns open_pr_against_main when no candidates", async () => {
  const result = await detectStackingTarget({
    self: { branch: "feature", headSha: "self", baseRef: "origin/main" },
    candidates: [],
    git: makeProbe({ files: { self: ["src/x.ts"] }, conflicts: {} }),
  });
  assert.equal(result.recommendation, "open_pr_against_main");
});

test("returns open_pr_against_main when files do not overlap", async () => {
  const candidates: SequenceCandidate[] = [
    { prNumber: 100, branch: "other", headSha: "cand", reviewState: "approved" },
  ];
  const result = await detectStackingTarget({
    self: { branch: "feature", headSha: "self", baseRef: "origin/main" },
    candidates,
    git: makeProbe({
      files: { self: ["src/x.ts"], cand: ["src/y.ts"] },
      conflicts: {},
    }),
  });
  assert.equal(result.recommendation, "open_pr_against_main");
});

test("returns open_pr_against_main when overlap exists but merge-tree clean", async () => {
  const candidates: SequenceCandidate[] = [
    { prNumber: 100, branch: "other", headSha: "cand" },
  ];
  const result = await detectStackingTarget({
    self: { branch: "feature", headSha: "self", baseRef: "origin/main" },
    candidates,
    git: makeProbe({
      files: { self: ["package.json"], cand: ["package.json"] },
      conflicts: {},
    }),
  });
  assert.equal(result.recommendation, "open_pr_against_main");
});

test("recommends rebase_onto when conflict detected", async () => {
  const candidates: SequenceCandidate[] = [
    {
      prNumber: 509,
      branch: "lsr-A",
      headSha: "candA",
      reviewState: "approved",
      checkStatus: "success",
    },
  ];
  const result = await detectStackingTarget({
    self: { branch: "feature", headSha: "self", baseRef: "origin/main" },
    candidates,
    git: makeProbe({
      files: { self: ["package.json", "pnpm-lock.yaml"], candA: ["package.json", "pnpm-lock.yaml"] },
      conflicts: { "self|candA": true },
    }),
  });
  assert.equal(result.recommendation, "rebase_onto");
  if (result.recommendation === "rebase_onto") {
    assert.equal(result.parentPr, 509);
    assert.equal(result.parentBranch, "lsr-A");
    assert.deepEqual(result.conflictingFiles, ["package.json", "pnpm-lock.yaml"]);
  }
});

test("scoring prefers approved+green over plain approved", async () => {
  const candidates: SequenceCandidate[] = [
    { prNumber: 1, branch: "a", headSha: "candA", reviewState: "approved" },
    {
      prNumber: 2,
      branch: "b",
      headSha: "candB",
      reviewState: "approved",
      checkStatus: "success",
    },
  ];
  const result = await detectStackingTarget({
    self: { branch: "feature", headSha: "self", baseRef: "origin/main" },
    candidates,
    git: makeProbe({
      files: { self: ["x"], candA: ["x"], candB: ["x"] },
      conflicts: { "self|candA": true, "self|candB": true },
    }),
  });
  assert.equal(result.recommendation, "rebase_onto");
  if (result.recommendation === "rebase_onto") {
    assert.equal(result.parentPr, 2, "approved+green should outrank plain approved");
  }
});

test("scoring prefers awaiting_queue (in queue) over plain approved", async () => {
  const candidates: SequenceCandidate[] = [
    { prNumber: 1, branch: "a", headSha: "candA", reviewState: "approved", checkStatus: "success" },
    { prNumber: 2, branch: "b", headSha: "candB", factoryState: "awaiting_queue" },
  ];
  const result = await detectStackingTarget({
    self: { branch: "feature", headSha: "self", baseRef: "origin/main" },
    candidates,
    git: makeProbe({
      files: { self: ["x"], candA: ["x"], candB: ["x"] },
      conflicts: { "self|candA": true, "self|candB": true },
    }),
  });
  if (result.recommendation === "rebase_onto") {
    assert.equal(result.parentPr, 2, "awaiting_queue should outrank approved+green");
  } else {
    assert.fail("expected rebase_onto");
  }
});

test("skips candidates with skip-labels", async () => {
  const candidates: SequenceCandidate[] = [
    { prNumber: 1, branch: "a", headSha: "candA", reviewState: "approved", labels: ["wip"] },
  ];
  const result = await detectStackingTarget({
    self: { branch: "feature", headSha: "self", baseRef: "origin/main" },
    candidates,
    git: makeProbe({
      files: { self: ["x"], candA: ["x"] },
      conflicts: { "self|candA": true },
    }),
  });
  assert.equal(result.recommendation, "open_pr_against_main");
});

test("ties broken by lowest PR number", async () => {
  const candidates: SequenceCandidate[] = [
    { prNumber: 200, branch: "a", headSha: "candA", reviewState: "approved" },
    { prNumber: 100, branch: "b", headSha: "candB", reviewState: "approved" },
  ];
  const result = await detectStackingTarget({
    self: { branch: "feature", headSha: "self", baseRef: "origin/main" },
    candidates,
    git: makeProbe({
      files: { self: ["x"], candA: ["x"], candB: ["x"] },
      conflicts: { "self|candA": true, "self|candB": true },
    }),
  });
  if (result.recommendation === "rebase_onto") {
    assert.equal(result.parentPr, 100);
  } else {
    assert.fail("expected rebase_onto");
  }
});

test("excludes self from candidates by branch", async () => {
  const candidates: SequenceCandidate[] = [
    { prNumber: 5, branch: "feature", headSha: "self" },
  ];
  const result = await detectStackingTarget({
    self: { branch: "feature", headSha: "self", baseRef: "origin/main" },
    candidates,
    git: makeProbe({
      files: { self: ["x"] },
      conflicts: { "self|self": true },
    }),
  });
  assert.equal(result.recommendation, "open_pr_against_main");
});
