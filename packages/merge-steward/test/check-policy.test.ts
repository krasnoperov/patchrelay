import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCheckPolicy } from "../src/check-policy.ts";

test("required check identity includes the producing GitHub App", () => {
  const required = [{ name: "Checks", appId: 42 }];

  assert.equal(
    evaluateCheckPolicy(required, false, [
      { name: "Checks", appId: 7, conclusion: "success" },
    ]).status,
    "pending",
    "a same-named check from another App is still a missing required check",
  );
  assert.equal(
    evaluateCheckPolicy(required, false, [
      { name: "Checks", appId: 42, conclusion: "success" },
    ]).status,
    "pass",
  );
});

test("required check evaluation fails closed for duplicate failure and pending runs", () => {
  const required = [{ name: "Checks", appId: 42 }];
  assert.equal(
    evaluateCheckPolicy(required, false, [
      { name: "Checks", appId: 42, conclusion: "success" },
      { name: "Checks", appId: 42, conclusion: "failure" },
    ]).status,
    "fail",
  );
  assert.equal(
    evaluateCheckPolicy(required, false, [
      { name: "Checks", appId: 42, conclusion: "success" },
      { name: "Checks", appId: 42, conclusion: "pending" },
    ]).status,
    "pending",
  );
});

test("a newer check-run id makes a rerun unambiguous", () => {
  const required = [{ name: "Checks", appId: 42 }];
  assert.equal(
    evaluateCheckPolicy(required, false, [
      { name: "Checks", appId: 42, runId: 100, conclusion: "failure" },
      { name: "Checks", appId: 42, runId: 101, conclusion: "success" },
    ]).status,
    "pass",
  );
  assert.equal(
    evaluateCheckPolicy(required, false, [
      { name: "Checks", appId: 42, runId: 101, conclusion: "success" },
      { name: "Checks", appId: 42, runId: 102, conclusion: "pending" },
    ]).status,
    "pending",
  );
});
