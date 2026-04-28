import assert from "node:assert/strict";
import test from "node:test";
import {
  PACKAGE_SPECS,
  compareVersions,
  highestBump,
  incrementVersion,
  planPackageRelease,
  versionCommandArgs,
} from "../.github/scripts/release-plan-lib.mjs";

test("planPackageRelease refuses to guess when npm is already ahead of the repo", () => {
  const plan = planPackageRelease({
    localVersion: "0.35.12",
    publishedVersion: "0.35.13",
    relevantSubjects: ["fix: keep fetching review comments"],
  });

  assert.equal(plan.release, false);
  assert.equal(plan.publish, false);
  assert.equal(plan.nextVersion, "0.35.12");
  assert.equal(plan.reason, "published_version_ahead_of_repo");
});

test("planPackageRelease honors manual version bumps that are ahead of npm", () => {
  const plan = planPackageRelease({
    localVersion: "0.35.13",
    publishedVersion: "0.35.12",
    relevantSubjects: [],
  });

  assert.equal(plan.release, true);
  assert.equal(plan.publish, true);
  assert.equal(plan.nextVersion, "0.35.13");
  assert.equal(plan.reason, "manual_version_bump");
});

test("planPackageRelease computes pre-1.0 bumps from conventional commits", () => {
  const featurePlan = planPackageRelease({
    localVersion: "0.35.12",
    publishedVersion: "0.35.12",
    relevantSubjects: ["feat: add review thread fetch fallback", "fix: tighten prompt context"],
  });
  assert.equal(featurePlan.nextVersion, "0.36.0");
  assert.equal(featurePlan.reason, "bump_minor");

  const breakingPlan = planPackageRelease({
    localVersion: "0.9.6",
    publishedVersion: "0.9.6",
    relevantSubjects: ["refactor!: replace release planner internals"],
  });
  assert.equal(breakingPlan.nextVersion, "0.10.0");
  assert.equal(breakingPlan.reason, "bump_minor");
});

test("version helpers compare and increment semver correctly", () => {
  assert.equal(compareVersions("0.35.12", "0.35.12"), 0);
  assert.equal(compareVersions("0.35.13", "0.35.12"), 1);
  assert.equal(compareVersions("0.35.12", "0.36.0"), -1);
  assert.equal(highestBump(["fix: tidy", "feat: add direct publish"], "0.35.12"), "minor");
  assert.equal(incrementVersion("0.35.12", "patch"), "0.35.13");
  assert.equal(incrementVersion("0.35.12", "minor"), "0.36.0");
});

test("root package ownership excludes workflow-only churn", () => {
  const rootSpec = PACKAGE_SPECS.find((entry) => entry.key === "root");
  assert.ok(rootSpec);
  assert.equal(rootSpec?.ownsFile(".github/workflows/release.yml"), false);
  assert.equal(rootSpec?.ownsFile("README.md"), false);
  assert.equal(rootSpec?.ownsFile("src/index.ts"), true);
  assert.equal(rootSpec?.ownsFile("infra/patchrelay.service"), true);
  assert.equal(rootSpec?.ownsFile("packages/merge-steward/src/cli.ts"), false);
});

test("versionCommandArgs updates workspace packages via npm prefix", () => {
  const rootSpec = PACKAGE_SPECS.find((entry) => entry.key === "root");
  const reviewQuillSpec = PACKAGE_SPECS.find((entry) => entry.key === "review_quill");

  assert.ok(rootSpec);
  assert.ok(reviewQuillSpec);
  assert.deepEqual(versionCommandArgs(rootSpec, "0.55.0"), [
    "npm",
    ["version", "0.55.0", "--no-git-tag-version"],
  ]);
  assert.deepEqual(versionCommandArgs(reviewQuillSpec, "0.16.0"), [
    "npm",
    ["--prefix", "packages/review-quill", "version", "0.16.0", "--no-git-tag-version"],
  ]);
});
