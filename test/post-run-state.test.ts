import assert from "node:assert/strict";
import test from "node:test";
import type { FactoryState, RunType } from "../src/factory-state.ts";
import {
  resolvePostRunFactoryState,
  type PostRunOutcome,
  type PostRunStateIssue,
} from "../src/run-completion-policy.ts";

// Plan §B3: table-driven coverage of the unified post-run resolver,
// enumerating runType × outcome × factoryState × prState × prReviewState
// (+ the reactive-intent inputs). The expectations encode the behavior of
// BOTH predecessor functions:
//   - outcome "completed"  ≙ the old resolveCompletedRunState
//   - outcome "recovered"  ≙ the old resolveRecoverablePostRunState
const RUN_TYPES: RunType[] = ["implementation", "ci_repair", "review_fix", "branch_upkeep", "queue_repair"];
const OUTCOMES: PostRunOutcome[] = ["completed", "recovered"];

interface Case {
  name: string;
  issue: Partial<PostRunStateIssue> & Pick<PostRunStateIssue, "factoryState">;
  expected: Record<PostRunOutcome, FactoryState | undefined>;
}

const CASES: Case[] = [
  // ─── No PR: nothing derivable from PR truth in either mode ───────
  {
    name: "no PR, active state",
    issue: { factoryState: "implementing" },
    expected: { completed: undefined, recovered: undefined },
  },
  {
    name: "no PR, idle state",
    issue: { factoryState: "delegated" },
    expected: { completed: undefined, recovered: undefined },
  },

  // ─── Merged PR ────────────────────────────────────────────────────
  {
    name: "merged PR, active state",
    issue: { factoryState: "implementing", prNumber: 7, prState: "merged" },
    expected: { completed: "done", recovered: "done" },
  },
  {
    // Divergence: completed gates on ACTIVE_RUN_STATES so a state advanced
    // concurrently (deploying, done, ...) is never clobbered; recovered
    // treats GitHub truth as authoritative.
    name: "merged PR, non-active state (deploying)",
    issue: { factoryState: "deploying", prNumber: 7, prState: "merged" },
    expected: { completed: undefined, recovered: "done" },
  },
  {
    name: "merged PR, changes_requested review verdict still cached",
    issue: { factoryState: "repairing_ci", prNumber: 7, prState: "merged", prReviewState: "changes_requested" },
    expected: { completed: "done", recovered: "done" },
  },

  // ─── Open PR, no reactive signal ──────────────────────────────────
  {
    name: "open PR, active state, no review verdict",
    issue: { factoryState: "implementing", prNumber: 7, prState: "open" },
    expected: { completed: "pr_open", recovered: "pr_open" },
  },
  {
    name: "open PR, active state, approved",
    issue: { factoryState: "implementing", prNumber: 7, prState: "open", prReviewState: "approved" },
    expected: { completed: "awaiting_queue", recovered: "awaiting_queue" },
  },
  {
    // Divergence: completed never writes from a non-active state.
    name: "open PR, non-active state (pr_open), approved",
    issue: { factoryState: "pr_open", prNumber: 7, prState: "open", prReviewState: "approved" },
    expected: { completed: undefined, recovered: "awaiting_queue" },
  },
  {
    name: "open PR, non-active state (awaiting_queue), no verdict",
    issue: { factoryState: "awaiting_queue", prNumber: 7, prState: "open" },
    expected: { completed: undefined, recovered: "pr_open" },
  },

  // ─── Open PR, reactive signal present ─────────────────────────────
  {
    // Divergence: a completed run already replaced the head the stale
    // verdict refers to (re-deriving would loop the fix); a recovered run
    // did not do its work, so the original problem is routed again.
    name: "open PR, changes_requested",
    issue: { factoryState: "changes_requested", prNumber: 7, prState: "open", prReviewState: "changes_requested" },
    expected: { completed: "pr_open", recovered: "changes_requested" },
  },
  {
    name: "open PR, red CI",
    issue: { factoryState: "repairing_ci", prNumber: 7, prState: "open", prCheckStatus: "failed" },
    expected: { completed: "pr_open", recovered: "repairing_ci" },
  },
  {
    name: "open PR, branch CI failure source",
    issue: { factoryState: "implementing", prNumber: 7, prState: "open", lastGitHubFailureSource: "branch_ci" },
    expected: { completed: "pr_open", recovered: "repairing_ci" },
  },
  {
    name: "open PR, queue eviction",
    issue: { factoryState: "repairing_queue", prNumber: 7, prState: "open", lastGitHubFailureSource: "queue_eviction" },
    expected: { completed: "pr_open", recovered: "repairing_queue" },
  },
  {
    // Reactive intent outranks the approved verdict in recovery — the queue
    // eviction is on the approved head, so the repair must run first.
    name: "open PR, approved but queue-evicted",
    issue: { factoryState: "repairing_queue", prNumber: 7, prState: "open", prReviewState: "approved", lastGitHubFailureSource: "queue_eviction" },
    expected: { completed: "awaiting_queue", recovered: "repairing_queue" },
  },
  {
    name: "open PR, red CI, non-active state",
    issue: { factoryState: "pr_open", prNumber: 7, prState: "open", prCheckStatus: "failed" },
    expected: { completed: undefined, recovered: "repairing_ci" },
  },

  // ─── Closed PR: both modes fall back to the factory-state-gated rule ──
  {
    name: "closed PR, active state, no verdict",
    issue: { factoryState: "implementing", prNumber: 7, prState: "closed" },
    expected: { completed: "pr_open", recovered: "pr_open" },
  },
  {
    name: "closed PR, active state, approved",
    issue: { factoryState: "changes_requested", prNumber: 7, prState: "closed", prReviewState: "approved" },
    expected: { completed: "awaiting_queue", recovered: "awaiting_queue" },
  },
  {
    name: "closed PR, non-active state",
    issue: { factoryState: "failed", prNumber: 7, prState: "closed" },
    expected: { completed: undefined, recovered: undefined },
  },

  // ─── Unknown prState (no snapshot yet) behaves like closed ────────
  {
    name: "PR number without prState, active state",
    issue: { factoryState: "implementing", prNumber: 7 },
    expected: { completed: "pr_open", recovered: "pr_open" },
  },
  {
    name: "PR number without prState, non-active state",
    issue: { factoryState: "escalated", prNumber: 7 },
    expected: { completed: undefined, recovered: undefined },
  },
];

function buildIssue(partial: Case["issue"]): PostRunStateIssue {
  return {
    prNumber: undefined,
    prState: undefined,
    prReviewState: undefined,
    prCheckStatus: undefined,
    lastGitHubFailureSource: undefined,
    ...partial,
  };
}

for (const entry of CASES) {
  for (const outcome of OUTCOMES) {
    test(`resolvePostRunFactoryState: ${entry.name} [${outcome}]`, () => {
      // The resolver derives state purely from PR truth + factory state; the
      // run's type must never change the answer.
      for (const runType of RUN_TYPES) {
        assert.equal(
          resolvePostRunFactoryState(buildIssue(entry.issue), { runType }, { outcome }),
          entry.expected[outcome],
          `runType=${runType}`,
        );
      }
    });
  }
}

test("resolvePostRunFactoryState defaults to the completed outcome", () => {
  const issue = buildIssue({ factoryState: "pr_open", prNumber: 7, prState: "open", prCheckStatus: "failed" });
  assert.equal(resolvePostRunFactoryState(issue, { runType: "implementation" }), undefined);
  assert.equal(
    resolvePostRunFactoryState(issue, { runType: "implementation" }, { outcome: "recovered" }),
    "repairing_ci",
  );
});
