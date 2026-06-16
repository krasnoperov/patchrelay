import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectConfig } from "../src/workflow-types.ts";
import { capacityBackoffStepMs, getCiRepairBudget, getQueueRepairBudget, getReviewFixBudget, resolveCapacityBackoffUntil } from "../src/run-budgets.ts";

test("capacityBackoffStepMs escalates 2 -> 5 -> 10 minutes and caps", () => {
  assert.equal(capacityBackoffStepMs(1), 2 * 60_000);
  assert.equal(capacityBackoffStepMs(2), 5 * 60_000);
  assert.equal(capacityBackoffStepMs(3), 10 * 60_000);
  assert.equal(capacityBackoffStepMs(4), 10 * 60_000, "caps at the longest step");
  assert.equal(capacityBackoffStepMs(0), 2 * 60_000, "treats <1 as the first attempt");
});

test("resolveCapacityBackoffUntil uses the escalating step when no retry time is given", () => {
  const now = Date.UTC(2026, 5, 16, 12, 0, 0);
  assert.equal(resolveCapacityBackoffUntil(undefined, 1, now, 0), new Date(now + 2 * 60_000).toISOString());
  assert.equal(resolveCapacityBackoffUntil(undefined, 2, now, 0), new Date(now + 5 * 60_000).toISOString());
  assert.equal(resolveCapacityBackoffUntil(undefined, 3, now, 0), new Date(now + 10 * 60_000).toISOString());
});

test("resolveCapacityBackoffUntil honors a provider retry time over the step", () => {
  const now = Date.UTC(2026, 5, 16, 12, 0, 0);
  const retryAt = new Date(now + 42 * 60_000).toISOString();
  assert.equal(resolveCapacityBackoffUntil(retryAt, 1, now, 0), retryAt);
});

function createProject(overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    id: "krasnoperov/test",
    repoPath: "/tmp/test",
    worktreeRoot: "/tmp/worktrees/test",
    issueKeyPrefixes: ["TST"],
    linearTeamIds: ["team-1"],
    allowLabels: [],
    reviewChecks: [],
    gateChecks: [],
    triggerEvents: ["statusChanged"],
    branchPrefix: "tst",
    repairBudgets: {
      ciRepair: 3,
      queueRepair: 3,
      reviewFix: 3,
    },
    ...overrides,
  };
}

test("run budgets fall back to defaults when no project is provided", () => {
  assert.equal(getCiRepairBudget(undefined), 10);
  assert.equal(getQueueRepairBudget(undefined), 10);
  assert.equal(getReviewFixBudget(undefined), 10);
});

test("run budgets read project-specific overrides", () => {
  const project = createProject({
    repairBudgets: {
      ciRepair: 7,
      queueRepair: 7,
      reviewFix: 7,
    },
  });

  assert.equal(getCiRepairBudget(project), 7);
  assert.equal(getQueueRepairBudget(project), 7);
  assert.equal(getReviewFixBudget(project), 7);
});
