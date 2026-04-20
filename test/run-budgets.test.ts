import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectConfig } from "../src/workflow-types.ts";
import { getCiRepairBudget, getQueueRepairBudget, getReviewFixBudget } from "../src/run-budgets.ts";

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
