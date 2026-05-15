import assert from "node:assert/strict";
import test from "node:test";
import {
  determinePendingCheckState,
  pendingCheckNames,
} from "../src/pending-check-classifier.ts";

test("determinePendingCheckState returns checks_unknown for empty inputs with no required checks", () => {
  assert.equal(determinePendingCheckState([], []), "checks_unknown");
});

test("determinePendingCheckState returns checks_running while any check is incomplete", () => {
  const checks = [
    { name: "verify", status: "completed", conclusion: "success" },
    { name: "lint", status: "in_progress" },
  ];
  assert.equal(determinePendingCheckState(checks, []), "checks_running");
});

test("determinePendingCheckState returns checks_failed when a completed check failed", () => {
  const checks = [
    { name: "verify", status: "completed", conclusion: "failure" },
  ];
  assert.equal(determinePendingCheckState(checks, []), "checks_failed");
});

test("determinePendingCheckState treats success/neutral/skipped as passing", () => {
  for (const conclusion of ["success", "neutral", "skipped"]) {
    const checks = [{ name: "verify", status: "completed", conclusion }];
    assert.equal(
      determinePendingCheckState(checks, []),
      "checks_unknown",
      `conclusion ${conclusion} should pass`,
    );
  }
});

test("determinePendingCheckState lower-cases names so configured required checks match in any case", () => {
  const checks = [{ name: "VERIFY", status: "completed", conclusion: "SUCCESS" }];
  assert.equal(determinePendingCheckState(checks, ["Verify"]), "checks_unknown");
});

test("determinePendingCheckState reports checks_running when a required check is missing entirely", () => {
  const checks = [{ name: "lint", status: "completed", conclusion: "success" }];
  assert.equal(determinePendingCheckState(checks, ["verify"]), "checks_running");
});

test("determinePendingCheckState reports checks_running when a required check is incomplete", () => {
  const checks = [{ name: "verify", status: "in_progress" }];
  assert.equal(determinePendingCheckState(checks, ["verify"]), "checks_running");
});

test("determinePendingCheckState reports checks_failed when a required check failed", () => {
  const checks = [
    { name: "verify", status: "completed", conclusion: "failure" },
    { name: "lint", status: "completed", conclusion: "success" },
  ];
  assert.equal(determinePendingCheckState(checks, ["verify"]), "checks_failed");
});

test("pendingCheckNames categorizes required checks by name", () => {
  const checks = [
    { name: "verify", status: "completed", conclusion: "failure" },
    { name: "lint", status: "in_progress" },
  ];
  const summary = pendingCheckNames(checks, ["verify", "lint", "build"]);
  assert.deepEqual(summary.failed, ["verify"]);
  assert.deepEqual(summary.pending, ["lint", "build"]);
});

test("pendingCheckNames falls back to all checks when no required list is configured", () => {
  const checks = [
    { name: "verify", status: "completed", conclusion: "failure" },
    { name: "lint", status: "in_progress" },
    { name: "format", status: "completed", conclusion: "success" },
  ];
  const summary = pendingCheckNames(checks, []);
  assert.deepEqual(summary.failed, ["verify"]);
  assert.deepEqual(summary.pending, ["lint"]);
});

test("pendingCheckNames preserves required-name casing in output even when matching case-insensitively", () => {
  const checks = [{ name: "verify", status: "completed", conclusion: "FAILURE" }];
  const summary = pendingCheckNames(checks, ["Verify"]);
  assert.deepEqual(summary.failed, ["Verify"]);
  assert.deepEqual(summary.pending, []);
});
