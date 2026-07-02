import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { FactoryState } from "../src/factory-state.ts";
import type { RunType } from "../src/run-type.ts";
import { PatchRelayDatabase } from "../src/db.ts";
import { MemoryPatchRelayTelemetry } from "../src/telemetry.ts";
import {
  deriveIssueSessionState,
  deriveIssueSessionStateLegacy,
  deriveIssueSessionWakeReason,
  deriveIssueSessionWakeReasonLegacy,
} from "../src/issue-session.ts";

// ── Fact-driven session_state derivation ───────────────────────────────────

test("merged PR derives session_state done regardless of factory state", () => {
  assert.equal(
    deriveIssueSessionState({ prState: "merged", compatibilityFactoryState: "pr_open" }),
    "done",
  );
  assert.equal(
    deriveIssueSessionState({ prState: "merged", compatibilityFactoryState: "done" }),
    "done",
  );
});

test("active run slot derives session_state running", () => {
  assert.equal(
    deriveIssueSessionState({ activeRunId: 42, prState: "open", compatibilityFactoryState: "implementing" }),
    "running",
  );
});

test("delegated with no PR and no run derives session_state idle", () => {
  assert.equal(
    deriveIssueSessionState({ compatibilityFactoryState: "delegated" }),
    "idle",
  );
});

test("requested-changes idle issue derives session_state idle plus a review wake reason", () => {
  assert.equal(
    deriveIssueSessionState({ prState: "open", compatibilityFactoryState: "changes_requested" }),
    "idle",
  );
  assert.equal(
    deriveIssueSessionWakeReason({
      delegatedToPatchRelay: true,
      compatibilityFactoryState: "changes_requested",
      prNumber: 7,
      prState: "open",
      prHeadSha: "reviewed-head",
      prReviewState: "changes_requested",
      lastBlockingReviewHeadSha: "reviewed-head",
    }),
    "review_changes_requested",
  );
});

test("undelegated issue yields no wake reason", () => {
  assert.equal(
    deriveIssueSessionWakeReason({
      delegatedToPatchRelay: false,
      compatibilityFactoryState: "changes_requested",
      prNumber: 7,
      prState: "open",
      prReviewState: "changes_requested",
    }),
    undefined,
  );
  // session_state itself stays idle (no active run, no terminal marker).
  assert.equal(
    deriveIssueSessionState({ prState: "open", compatibilityFactoryState: "changes_requested" }),
    "idle",
  );
});

test("awaiting_input derives waiting_input plus a human-reply wake reason", () => {
  assert.equal(
    deriveIssueSessionState({ compatibilityFactoryState: "awaiting_input" }),
    "waiting_input",
  );
  assert.equal(
    deriveIssueSessionWakeReason({
      delegatedToPatchRelay: true,
      compatibilityFactoryState: "awaiting_input",
    }),
    "waiting_for_human_reply",
  );
});

test("pending wake run type drives the session wake reason", () => {
  const cases: Array<[RunType, string]> = [
    ["implementation", "delegated"],
    ["review_fix", "review_changes_requested"],
    ["branch_upkeep", "branch_upkeep"],
    ["ci_repair", "settled_red_ci"],
    ["queue_repair", "merge_steward_incident"],
  ];
  for (const [pendingWakeRunType, expected] of cases) {
    assert.equal(
      deriveIssueSessionWakeReason({
        delegatedToPatchRelay: true,
        pendingWakeRunType,
        compatibilityFactoryState: "delegated",
      }),
      expected,
      `pending wake ${pendingWakeRunType}`,
    );
  }
});

// ── Shadow parity: old (factory-keyed) and new (fact-keyed) agree on known
// shapes, so state.projection_divergence stays silent in production. ─────────

test("session_state parity across legal factory-state × pr-state × run shapes", () => {
  const factoryStates: FactoryState[] = [
    "delegated",
    "implementing",
    "pr_open",
    "changes_requested",
    "repairing_ci",
    "awaiting_queue",
    "repairing_queue",
    "deploying",
    "awaiting_input",
    "escalated",
    "done",
    "failed",
  ];
  const activeRunIds: Array<number | undefined> = [undefined, 5];
  for (const factoryState of factoryStates) {
    for (const activeRunId of activeRunIds) {
      // A merged PR only legally co-occurs with factoryState "done"; other
      // pr states never force a session_state that factory disagrees with.
      const prStates: Array<string | undefined> = factoryState === "done"
        ? [undefined, "merged", "open"]
        : [undefined, "open", "closed"];
      for (const prState of prStates) {
        const legacy = deriveIssueSessionStateLegacy({
          ...(activeRunId !== undefined ? { activeRunId } : {}),
          factoryState,
        });
        const next = deriveIssueSessionState({
          ...(activeRunId !== undefined ? { activeRunId } : {}),
          ...(prState !== undefined ? { prState } : {}),
          compatibilityFactoryState: factoryState,
        });
        assert.equal(
          next,
          legacy,
          `session_state divergence for factoryState=${factoryState} prState=${prState} activeRunId=${activeRunId}`,
        );
      }
    }
  }
});

test("wake reason parity when the pending wake run type matches the legacy column", () => {
  const runTypes: Array<RunType | undefined> = [
    undefined,
    "implementation",
    "review_fix",
    "branch_upkeep",
    "ci_repair",
    "queue_repair",
  ];
  const delegations: Array<boolean | undefined> = [undefined, true, false];
  const factoryStates: FactoryState[] = ["delegated", "pr_open", "awaiting_input", "changes_requested"];
  for (const runType of runTypes) {
    for (const delegatedToPatchRelay of delegations) {
      for (const factoryState of factoryStates) {
        const legacy = deriveIssueSessionWakeReasonLegacy({
          delegatedToPatchRelay,
          pendingRunType: runType,
          factoryState,
        });
        const next = deriveIssueSessionWakeReason({
          delegatedToPatchRelay,
          pendingWakeRunType: runType,
          compatibilityFactoryState: factoryState,
        });
        assert.equal(
          next,
          legacy,
          `wake reason divergence for runType=${runType} delegated=${delegatedToPatchRelay} factoryState=${factoryState}`,
        );
      }
    }
  }
});

// ── Divergence telemetry wiring through the projector ───────────────────────

test("projector emits state.projection_divergence when facts and factory state disagree", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-projection-divergence-"));
  try {
    const telemetry = new MemoryPatchRelayTelemetry();
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true, telemetry);
    db.runMigrations();

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-diverge",
      issueKey: "USE-DIVERGE",
      factoryState: "implementing",
      branchName: "use/USE-DIVERGE",
    });
    // Baseline: both derivations agree (idle) — no divergence yet.
    assert.equal(telemetry.list("state.projection_divergence").length, 0);

    // Force a transient shape the legacy path can't see: PR merged while
    // factory_state still lags at pr_open. New derivation → done, legacy → idle.
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-diverge",
      factoryState: "pr_open",
      prNumber: 11,
      prState: "merged",
    });

    const session = db.issueSessions.getIssueSession("usertold", "issue-diverge");
    assert.equal(session?.sessionState, "done");

    const divergences = telemetry.list("state.projection_divergence");
    const sessionDivergence = divergences.find((event) => event.field === "session_state");
    assert.ok(sessionDivergence, "expected a session_state divergence event");
    assert.equal(sessionDivergence?.oldValue, "idle");
    assert.equal(sessionDivergence?.newValue, "done");
    assert.equal(sessionDivergence?.issueKey, "USE-DIVERGE");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
