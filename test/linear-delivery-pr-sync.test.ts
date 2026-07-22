import assert from "node:assert/strict";
import test from "node:test";
import { syncLinearDeliveryPrAttachment } from "../src/linear-delivery-pr-sync.ts";
import type { LinearClient } from "../src/types.ts";

test("syncs an idempotent machine-tagged Linear attachment for the delivery PR", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const linear: Partial<LinearClient> = {
    upsertIssueAttachment: async (params) => {
      calls.push(params);
      return { id: "attachment-42" };
    },
  };

  await syncLinearDeliveryPrAttachment({
    linearIssueId: "linear-issue-42",
    issueKey: "INV-42",
    projectId: "krasnoperov/inventory",
    prNumber: 42,
    prUrl: "https://github.com/krasnoperov/inventory/pull/42",
    prState: "open",
  }, linear as LinearClient);

  assert.deepEqual(calls, [{
    issueId: "linear-issue-42",
    title: "PatchRelay delivery PR #42",
    subtitle: "open",
    url: "https://github.com/krasnoperov/inventory/pull/42",
    metadata: {
      patchrelayRelationship: "delivery_pr",
      patchrelayIssueKey: "INV-42",
      patchrelayProjectId: "krasnoperov/inventory",
      githubPrNumber: 42,
    },
  }]);
});

test("does nothing until a complete PR identity is available", async () => {
  const linear: Partial<LinearClient> = {
    upsertIssueAttachment: async () => {
      assert.fail("attachment should not be created");
    },
  };

  await syncLinearDeliveryPrAttachment({
    linearIssueId: "linear-issue-42",
    issueKey: "INV-42",
    projectId: "krasnoperov/inventory",
  }, linear as LinearClient);
});
