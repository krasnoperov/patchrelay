import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWebhook, shouldReconcileWebhook } from "../src/webhook-handler.ts";

const repos = [
  { repoFullName: "owner/immediate", waitForGreenChecks: false },
  { repoFullName: "owner/gated", waitForGreenChecks: true },
];

test("shouldReconcileWebhook ignores check events for repos that review immediately", () => {
  assert.deepEqual(
    shouldReconcileWebhook({ type: "check_run", repoFullName: "owner/immediate" }, repos),
    { reconcile: false, ignoredReason: "checks_ignored_without_green_gate" },
  );
  assert.deepEqual(
    shouldReconcileWebhook({ type: "check_suite", repoFullName: "owner/immediate" }, repos),
    { reconcile: false, ignoredReason: "checks_ignored_without_green_gate" },
  );
});

test("shouldReconcileWebhook still reconciles pull requests and green-gated check events", () => {
  assert.deepEqual(
    shouldReconcileWebhook({ type: "pull_request", repoFullName: "owner/immediate" }, repos),
    { reconcile: true },
  );
  assert.deepEqual(
    shouldReconcileWebhook({ type: "check_run", repoFullName: "owner/gated" }, repos),
    { reconcile: true },
  );
});

test("push events wake reconciliation for candidate ref changes", () => {
  const event = normalizeWebhook("push", {
    repository: { full_name: "owner/repo" },
    ref: "refs/heads/merge-steward/main/pr-104",
  });
  assert.deepEqual(event, { type: "push", repoFullName: "owner/repo" });
  assert.deepEqual(shouldReconcileWebhook(event!, [{ repoFullName: "owner/repo", waitForGreenChecks: false }]), { reconcile: true });
});
