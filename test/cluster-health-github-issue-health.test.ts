import assert from "node:assert/strict";
import test from "node:test";
import { evaluateGitHubIssueHealth } from "../src/cli/cluster-health/github-issue-health.ts";
import type { CommandRunner } from "../src/cli/command-types.ts";
import type { IssueRecord } from "../src/db-types.ts";
import type { AppConfig } from "../src/types.ts";

function config(): AppConfig {
  return {
    projects: [
      {
        id: "krasnoperov/subtitles",
        repoPath: "/repo",
        worktreeRoot: "/worktrees",
        issueKeyPrefixes: ["LSR"],
        linearTeamIds: [],
        linearProjectIds: [],
        allowLabels: [],
        reviewChecks: [],
        gateChecks: [],
        repairBudgets: { ciRepair: 10, queueRepair: 10, reviewFix: 10 },
        github: { repoFullName: "krasnoperov/subtitles", baseBranch: "main" },
      },
    ],
  } as never;
}

function issue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id: 1,
    projectId: "krasnoperov/subtitles",
    linearIssueId: "issue-lsr-892",
    issueKey: "LSR-892",
    title: "Noindex previews",
    delegatedToPatchRelay: true,
    issueClass: "implementation",
    currentLinearState: "In Merge Queue",
    workflowOutcome: undefined,
    prNumber: 1812,
    prState: "open",
    prReviewState: "approved",
    updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    blockedByCount: 0,
    readyForExecution: false,
    ...overrides,
  } as never;
}

test("evaluateGitHubIssueHealth flags approved awaiting_queue PRs with failed default Tests gate", async () => {
  const runCommand: CommandRunner = async () => ({
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify({
      state: "OPEN",
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      headRefOid: "sha-red",
      statusCheckRollup: [
        { __typename: "CheckRun", name: "Tests", status: "COMPLETED", conclusion: "FAILURE" },
      ],
      reviewRequests: [],
      latestReviews: [],
    }),
  });

  const result = await evaluateGitHubIssueHealth(
    {
      issue: issue(),
      blockedBy: [],
      missingTrackedBlockers: [],
      ageMs: 10 * 60_000,
      readyForExecution: false,
      executionState: { kind: "idle_awaiting_external", waitingOn: "merge_queue" },
    },
    config(),
    runCommand,
  );

  assert.equal(result.ciEntry?.gateStatus, "failure");
  assert.equal(result.ciEntry?.owner, "unknown");
  assert.equal(result.ciEntry?.orphaned, true);
  assert.equal(result.finding?.status, "fail");
  assert.equal(result.finding?.scope, "github:ci");
  assert.match(result.finding?.message ?? "", /approved but gate CI is red/i);
});
