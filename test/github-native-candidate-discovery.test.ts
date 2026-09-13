import assert from "node:assert/strict";
import test from "node:test";
import { discoverGitHubNativeCandidateRepairs } from "../src/github-native-candidate-discovery.ts";
import type { AppConfig } from "../src/types.ts";
import type { execCommand } from "../src/utils.ts";

test("one unavailable repository does not abort discovery for other repositories", async () => {
  const projects = ["broken", "healthy"].map((name) => ({
    id: name,
    repoPath: `/tmp/${name}`,
    worktreeRoot: `/tmp/${name}-worktrees`,
    issueKeyPrefixes: [],
    linearTeamIds: [],
    linearProjectIds: [],
    reviewChecks: [],
    gateChecks: ["Tests"],
    triggerEvents: [],
    branchPrefix: name,
    repairBudgets: { ciRepair: 1, queueRepair: 1, reviewFix: 1 },
    github: { repoFullName: `owner/${name}`, baseBranch: "main" },
  }));
  const config = { projects } as unknown as AppConfig;
  const errors: string[] = [];
  const runCommand: typeof execCommand = async (_command, args) => {
    const endpoint = args[1] ?? "";
    if (endpoint.includes("owner/broken")) throw new Error("GitHub timed out");
    if (endpoint.includes("matching-refs")) {
      return { stdout: "refs/heads/merge-steward/main/pr-77\n", stderr: "", exitCode: 0 };
    }
    if (args[0] === "pr") {
      return {
        stdout: JSON.stringify({
          state: "OPEN",
          isDraft: false,
          title: "Healthy repair",
          headRefName: "feature/healthy",
          headRefOid: "approved-head",
          baseRefName: "main",
          reviewDecision: "APPROVED",
          reviews: [{ state: "APPROVED", commit: { oid: "approved-head" } }],
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    if (endpoint.includes("commits/approved-head/check-runs")) {
      return { stdout: "Tests\tcompleted\tsuccess\t\n", stderr: "", exitCode: 0 };
    }
    if (endpoint.includes("git/ref/heads/merge-steward/main/pr-77")) {
      return { stdout: "candidate-base\n", stderr: "", exitCode: 0 };
    }
    if (endpoint.includes("compare/approved-head...candidate-base")) {
      return { stdout: "diverged\n", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "unexpected command", exitCode: 1 };
  };

  const repairs = await discoverGitHubNativeCandidateRepairs({
    config,
    isTracked: () => false,
    runCommand,
    onCommandError: ({ repoFullName, error }) => errors.push(`${repoFullName}: ${error}`),
  });

  assert.deepEqual(errors, ["owner/broken: GitHub timed out"]);
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0]?.repoFullName, "owner/healthy");
  assert.equal(repairs[0]?.candidate.kind, "conflicted");
});
