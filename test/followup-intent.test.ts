import assert from "node:assert/strict";
import test from "node:test";
import { classifyFollowupIntent } from "../src/followup-intent.ts";

test("classifyFollowupIntent detects status questions without treating them as work", () => {
  assert.equal(classifyFollowupIntent("what's the status?"), "status");
  assert.equal(classifyFollowupIntent("what is deployed so far?"), "status");
  assert.equal(classifyFollowupIntent("any progress update"), "status");
});

test("classifyFollowupIntent detects retry prompts", () => {
  assert.equal(classifyFollowupIntent("please continue"), "retry");
  assert.equal(classifyFollowupIntent("retry the run"), "retry");
  assert.equal(classifyFollowupIntent("go on"), "retry");
});

test("classifyFollowupIntent prefers implementation requests over generic questions", () => {
  assert.equal(classifyFollowupIntent("can you implement USE-167?"), "implementation_request");
  assert.equal(classifyFollowupIntent("PatchRelay, please keep this compatible with the old contract."), "implementation_request");
  assert.equal(classifyFollowupIntent("merge this when green"), "implementation_request");
});

test("classifyFollowupIntent separates clarification and stop prompts", () => {
  assert.equal(classifyFollowupIntent("FYI, the API must stay stable."), "clarification");
  assert.equal(classifyFollowupIntent("stop working on this"), "stop");
});
