import assert from "node:assert/strict";
import test from "node:test";
import {
  interpretDeployRuns,
  isDeployTrackingEnabled,
  type DeployRunSummary,
} from "../src/post-merge-deploy.ts";
import type { ProjectConfig } from "../src/workflow-types.ts";

function project(deployWorkflowName?: string): ProjectConfig {
  return {
    id: "p",
    repoPath: "/tmp/p",
    reviewChecks: [],
    gateChecks: [],
    github: { repoFullName: "o/r", baseBranch: "main", ...(deployWorkflowName ? { deployWorkflowName } : {}) },
  } as ProjectConfig;
}

const SINCE = "2026-05-24T01:00:00.000Z";
const after = (mins: number) => new Date(Date.parse(SINCE) + mins * 60_000).toISOString();
const before = (mins: number) => new Date(Date.parse(SINCE) - mins * 60_000).toISOString();
const run = (status: string, conclusion: string | null, createdAt: string): DeployRunSummary =>
  ({ status, conclusion, createdAt });

test("deploy tracking is enabled only when a deploy workflow is configured", () => {
  assert.equal(isDeployTrackingEnabled(project("Deploy")), true);
  assert.equal(isDeployTrackingEnabled(project()), false);
  assert.equal(isDeployTrackingEnabled(undefined), false);
});

test("interpretDeployRuns: a completed successful deploy after merge → succeeded", () => {
  assert.equal(interpretDeployRuns([run("completed", "success", after(1))], SINCE), "succeeded");
});

test("interpretDeployRuns: a completed failed deploy after merge → failed", () => {
  assert.equal(interpretDeployRuns([run("completed", "failure", after(2))], SINCE), "failed");
  assert.equal(interpretDeployRuns([run("completed", "timed_out", after(2))], SINCE), "failed");
});

test("interpretDeployRuns: an in-progress deploy → pending", () => {
  assert.equal(interpretDeployRuns([run("in_progress", null, after(1))], SINCE), "pending");
  assert.equal(interpretDeployRuns([run("queued", null, after(1))], SINCE), "pending");
});

test("interpretDeployRuns: the most recent decisive run wins; cancelled is skipped", () => {
  // newest is cancelled, older is success → the success is decisive.
  const runs = [run("completed", "cancelled", after(5)), run("completed", "success", after(3))];
  assert.equal(interpretDeployRuns(runs, SINCE), "succeeded");
});

test("interpretDeployRuns: runs created before the merge are ignored → pending", () => {
  assert.equal(interpretDeployRuns([run("completed", "success", before(10))], SINCE), "pending");
});

test("interpretDeployRuns: no runs → pending", () => {
  assert.equal(interpretDeployRuns([], SINCE), "pending");
});

test("interpretDeployRuns: grace window keeps a deploy created just before the stamp", () => {
  // 1 minute before `since` is within the 2-minute grace.
  assert.equal(interpretDeployRuns([run("completed", "success", before(1))], SINCE), "succeeded");
});
