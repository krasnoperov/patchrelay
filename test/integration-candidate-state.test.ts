import assert from "node:assert/strict";
import test from "node:test";
import {
  integrationCandidateBranch,
  readIntegrationCandidateState,
} from "../src/integration-candidate-state.ts";
import { resolveRunWorkspace } from "../src/run-launcher.ts";

type CommandResult = Awaited<ReturnType<NonNullable<Parameters<typeof readIntegrationCandidateState>[0]["runCommand"]>>>;

function runner(outputs: CommandResult[]) {
  const calls: string[][] = [];
  const runCommand = async (_command: string, args: string[]) => {
    calls.push(args);
    const next = outputs.shift();
    assert.ok(next, `unexpected command: ${args.join(" ")}`);
    return next;
  };
  return { calls, runCommand };
}

const ok = (stdout: string): CommandResult => ({ stdout, stderr: "", exitCode: 0 });

test("candidate branch is self-describing from base and PR number", () => {
  assert.equal(integrationCandidateBranch("release/next", 104), "merge-steward/release/next/pr-104");
});

test("candidate lacking approved-head ancestry derives conflict repair", async () => {
  const fake = runner([ok("candidate-1\n"), ok("diverged\n")]);
  const state = await readIntegrationCandidateState({
    repoFullName: "owner/repo",
    baseBranch: "main",
    prNumber: 104,
    approvedHeadSha: "approved-1",
    requiredChecks: ["Tests"],
    runCommand: fake.runCommand,
  });
  assert.deepEqual(state, {
    kind: "conflicted",
    branch: "merge-steward/main/pr-104",
    candidateSha: "candidate-1",
    approvedHeadSha: "approved-1",
  });
  assert.match(fake.calls[1]!.join(" "), /approved-1\.\.\.candidate-1/);
});

test("candidate containing approved head derives settled red candidate CI", async () => {
  const fake = runner([
    ok("candidate-2\n"),
    ok("ahead\n"),
    ok("Tests\tcompleted\tfailure\thttps://checks/1\nStatic\tcompleted\tsuccess\thttps://checks/2\n"),
  ]);
  const state = await readIntegrationCandidateState({
    repoFullName: "owner/repo",
    baseBranch: "main",
    prNumber: 105,
    approvedHeadSha: "approved-2",
    requiredChecks: ["Tests", "Static"],
    runCommand: fake.runCommand,
  });
  assert.equal(state?.kind, "failed");
  assert.deepEqual(state?.kind === "failed" ? state.failedChecks.map((check) => check.name) : [], ["Tests"]);
});

test("pending candidate does not become repair work", async () => {
  const fake = runner([
    ok("candidate-3\n"),
    ok("identical\n"),
    ok("Tests\tin_progress\t\thttps://checks/3\n"),
  ]);
  const state = await readIntegrationCandidateState({
    repoFullName: "owner/repo",
    baseBranch: "main",
    prNumber: 106,
    approvedHeadSha: "candidate-3",
    requiredChecks: ["Tests"],
    runCommand: fake.runCommand,
  });
  assert.equal(state?.kind, "pending");
});

test("integration repair gets a separate candidate worktree and branch", () => {
  assert.deepEqual(resolveRunWorkspace({
    runType: "integration_repair",
    candidateBranch: "merge-steward/main/pr-104",
    issueBranch: "feature/FX-68",
    issueWorktreePath: "/worktrees/FX-68",
    defaultBranch: "feature/FX-68",
    defaultWorktreePath: "/worktrees/FX-68",
    integrationWorktreePath: "/worktrees/FX-68-integration",
  }), {
    branchName: "merge-steward/main/pr-104",
    worktreePath: "/worktrees/FX-68-integration",
  });
});
