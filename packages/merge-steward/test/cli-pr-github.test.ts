import assert from "node:assert/strict";
import test from "node:test";
import { fetchPrGitHubOverview, parsePrView } from "../src/cli/commands/pr-github.ts";
import type { ResolveCommandRunner } from "../src/cli/resolve.ts";

test("parsePrView marks check runs completed with success conclusion as success", () => {
  const raw = JSON.stringify({
    number: 12,
    headRefName: "feat/x",
    headRefOid: "abc",
    state: "OPEN",
    reviewDecision: "REVIEW_REQUIRED",
    labels: [{ name: "queue" }],
    statusCheckRollup: [
      { __typename: "CheckRun", name: "ci / build", status: "COMPLETED", conclusion: "SUCCESS", isRequired: true },
    ],
  });
  const overview = parsePrView(raw);
  assert.equal(overview.checks.length, 1);
  assert.equal(overview.checks[0]?.status, "success");
  assert.equal(overview.checks[0]?.required, true);
  assert.deepEqual(overview.labels, ["queue"]);
});

test("parsePrView classifies failures and pending checks", () => {
  const raw = JSON.stringify({
    number: 13,
    headRefName: "feat/y",
    headRefOid: "def",
    state: "OPEN",
    statusCheckRollup: [
      { __typename: "CheckRun", name: "ci / test", status: "COMPLETED", conclusion: "FAILURE", isRequired: true },
      { __typename: "CheckRun", name: "ci / lint", status: "IN_PROGRESS", conclusion: null },
      { __typename: "StatusContext", context: "deploy/preview", state: "SUCCESS" },
    ],
  });
  const overview = parsePrView(raw);
  assert.equal(overview.checks[0]?.status, "failure");
  assert.equal(overview.checks[1]?.status, "pending");
  assert.equal(overview.checks[2]?.status, "success");
  assert.equal(overview.checks[2]?.name, "deploy/preview");
});

test("parsePrView sets merged=true when state=MERGED", () => {
  const raw = JSON.stringify({
    number: 14,
    headRefName: "main",
    headRefOid: "ghi",
    state: "MERGED",
  });
  const overview = parsePrView(raw);
  assert.equal(overview.state, "MERGED");
  assert.equal(overview.merged, true);
});

test("parsePrView tolerates missing labels and statusCheckRollup", () => {
  const raw = JSON.stringify({
    number: 15,
    headRefName: "feat/z",
    headRefOid: "jkl",
    state: "OPEN",
  });
  const overview = parsePrView(raw);
  assert.deepEqual(overview.labels, []);
  assert.deepEqual(overview.checks, []);
});

test("fetchPrGitHubOverview shells to gh pr view with expected args", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: ResolveCommandRunner = async (command, args) => {
    calls.push({ command, args });
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        number: 42,
        headRefName: "feat/x",
        headRefOid: "abc",
        state: "OPEN",
        reviewDecision: "APPROVED",
      }),
      stderr: "",
    };
  };
  const overview = await fetchPrGitHubOverview("owner/app", 42, runner);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "gh");
  assert.deepEqual(calls[0]?.args.slice(0, 5), ["pr", "view", "42", "--repo", "owner/app"]);
  assert.equal(overview.reviewDecision, "APPROVED");
});

test("fetchPrGitHubOverview surfaces stderr when gh fails", async () => {
  const runner: ResolveCommandRunner = async () => ({
    exitCode: 1,
    stdout: "",
    stderr: "could not find pull request",
  });
  await assert.rejects(
    fetchPrGitHubOverview("owner/app", 42, runner),
    (error) => error instanceof Error && /could not find pull request/.test(error.message),
  );
});
