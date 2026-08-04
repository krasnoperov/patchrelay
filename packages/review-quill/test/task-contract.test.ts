import assert from "node:assert/strict";
import test from "node:test";
import { extractPatchRelayTaskContract } from "../src/prompt-context/task-contract.ts";

test("extractPatchRelayTaskContract preserves the task between versioned PR-body markers", () => {
  const task = [
    "Issue: INV-979",
    "Title: Submit audio without duration preflight",
    "",
    "## Acceptance criteria",
    "",
    "- Known durations over 15 seconds are submitted unchanged.",
  ].join("\n");
  const body = [
    "## Summary",
    "An implementation summary that may be wrong.",
    "",
    "<!-- patchrelay-task-contract:v1:start -->",
    task,
    "<!-- patchrelay-task-contract:v1:end -->",
  ].join("\n");

  assert.equal(extractPatchRelayTaskContract(body), task);
});

test("extractPatchRelayTaskContract ignores missing or incomplete contracts", () => {
  assert.equal(extractPatchRelayTaskContract(undefined), undefined);
  assert.equal(extractPatchRelayTaskContract("Issue: INV-979"), undefined);
  assert.equal(extractPatchRelayTaskContract("<!-- patchrelay-task-contract:v1:start -->\nIssue: INV-979"), undefined);
});
