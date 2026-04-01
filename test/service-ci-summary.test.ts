import assert from "node:assert/strict";
import test from "node:test";
import { parseCiSnapshotSummary } from "../src/service.ts";

test("parseCiSnapshotSummary collapses duplicate check runs to the latest effective check per name", () => {
  const summary = parseCiSnapshotSummary(JSON.stringify({
    headSha: "abc123",
    gateCheckName: "Tests",
    gateCheckStatus: "success",
    failedChecks: [],
    capturedAt: "2026-04-02T10:00:00.000Z",
    checks: [
      { name: "Build & UI Tests", status: "success" },
      { name: "Tests", status: "success" },
      { name: "Build & UI Tests", status: "failure" },
      { name: "Tests", status: "failure" },
      { name: "AI Review", status: "success" },
    ],
  }));

  assert.deepEqual(summary, {
    total: 3,
    completed: 3,
    passed: 3,
    failed: 0,
    pending: 0,
    overall: "success",
  });
});

test("parseCiSnapshotSummary preserves current failures and exposes failing check names", () => {
  const summary = parseCiSnapshotSummary(JSON.stringify({
    headSha: "def456",
    gateCheckName: "Tests",
    gateCheckStatus: "failure",
    failedChecks: [{ name: "Build & UI Tests", status: "failure" }],
    capturedAt: "2026-04-02T10:05:00.000Z",
    checks: [
      { name: "Build & UI Tests", status: "failure" },
      { name: "Tests", status: "failure" },
      { name: "AI Review", status: "success" },
      { name: "Tests", status: "success" },
    ],
  }));

  assert.deepEqual(summary, {
    total: 3,
    completed: 3,
    passed: 1,
    failed: 2,
    pending: 0,
    overall: "failure",
    failedNames: ["Build & UI Tests", "Tests"],
  });
});
