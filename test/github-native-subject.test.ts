import assert from "node:assert/strict";
import test from "node:test";
import { githubNativeSubjectId, isGitHubNativeSubject } from "../src/github-native-subject.ts";

test("GitHub-native repair subjects have a stable machine-owned identity", () => {
  const id = githubNativeSubjectId("owner/repo", 42);
  assert.equal(id, "github-pr:owner/repo#42");
  assert.equal(isGitHubNativeSubject(id), true);
  assert.equal(isGitHubNativeSubject("linear-issue-id"), false);
});
