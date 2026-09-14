import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveConflictRepairOwnership,
  type ConflictRepairOwnership,
} from "../src/conflict-repair-ownership.ts";
import type { IntegrationCandidateState } from "../src/integration-candidate-state.ts";
import type { AppConfig } from "../src/types.ts";

const project = {
  id: "usertold",
  github: {
    repoFullName: "owner/repo",
    baseBranch: "main",
  },
  gateChecks: ["verify"],
} as AppConfig["projects"][number];

async function resolve(candidate: IntegrationCandidateState | undefined): Promise<ConflictRepairOwnership> {
  return resolveConflictRepairOwnership({
    project,
    prNumber: 113,
    approvedHeadSha: "approved-sha",
    readCandidateState: async () => candidate,
  });
}

test("a published candidate owns conflict repair and preserves its identity", async () => {
  assert.deepEqual(await resolve({
    kind: "pending",
    branch: "merge-steward/main/pr-113",
    candidateSha: "candidate-sha",
    approvedHeadSha: "approved-sha",
    checks: [],
  }), {
    owner: "integration_candidate",
    candidateKind: "pending",
    candidateSha: "candidate-sha",
  });
});

test("an uncertain candidate read fails closed to integration ownership", async () => {
  assert.deepEqual(await resolve(undefined), {
    owner: "integration_candidate",
    candidateKind: "unknown",
  });
});

test("only a proven absent candidate grants feature-branch repair", async () => {
  assert.deepEqual(await resolve({
    kind: "absent",
    branch: "merge-steward/main/pr-113",
  }), {
    owner: "feature_branch",
    candidateKind: "absent",
  });
});
