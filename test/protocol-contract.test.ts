import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MERGE_QUEUE_CHECK_NAME,
  DEFAULT_MERGE_QUEUE_LABEL,
  resolveMergeQueueProtocol,
} from "../src/merge-queue-protocol.ts";
import { stewardConfigSchema } from "../packages/merge-steward/src/config.ts";

test("merge queue protocol defaults stay aligned across PatchRelay and Merge Steward", () => {
  const protocol = resolveMergeQueueProtocol({
    id: "usertold",
    repoPath: "/repo",
    worktreeRoot: "/worktrees",
    issueKeyPrefixes: [],
    linearTeamIds: [],
    allowLabels: [],
    reviewChecks: [],
    gateChecks: [],
    triggerEvents: ["statusChanged"],
    branchPrefix: "use",
  });

  const stewardConfig = stewardConfigSchema.parse({
    repoId: "repo-1",
    repoFullName: "owner/repo",
    clonePath: "/tmp/clone",
    database: { path: ":memory:" },
  });

  assert.equal(DEFAULT_MERGE_QUEUE_LABEL, "queue");
  assert.equal(DEFAULT_MERGE_QUEUE_CHECK_NAME, "merge-steward/queue");
  assert.equal(protocol.admissionLabel, "queue");
  assert.equal(protocol.evictionCheckName, "merge-steward/queue");
  assert.equal(stewardConfig.admissionLabel, "queue");
  assert.equal(stewardConfig.mergeQueueCheckName, "merge-steward/queue");
});
