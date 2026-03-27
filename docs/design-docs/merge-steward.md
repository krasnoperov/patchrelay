# Merge Steward

## Purpose

This document defines the target merge-queue architecture for PatchRelay:

- PatchRelay owns issue worktrees and agentic coding loops
- a separate `merge-steward` service owns queue ordering, speculative validation, and final landing

This replaces the earlier idea that PatchRelay itself should also be the merge queue engine.

## Why Split The Queue From PatchRelay

The merge queue is a deterministic control problem.
It should keep making progress even when agent execution is unavailable, degraded, or expensive.

Observed behavior in the `USE-84` through `USE-101` batch showed that PatchRelay spent much more work on orchestration churn than on real code repair:

- 232 recorded runs for the batch
- 173 runs were clearly infrastructure-like or reconciliation churn
- only a small minority were actual queue-conflict failures

That is a bad fit for putting queue advancement behind the same runtime that owns Codex threads, restart recovery, and agent repair loops.

## Core Decision

PatchRelay should not own the merge queue directly.

Instead:

- PatchRelay produces and maintains PR branches
- PatchRelay reacts to review feedback and branch-local CI failures
- `merge-steward` decides what is eligible to land
- `merge-steward` serializes integration against `main`
- `merge-steward` asks PatchRelay for help only when an agent is actually needed

## Responsibility Split

| System | Owns |
|-|-|
| PatchRelay | Linear session UX, issue worktrees, implementation runs, review-fix runs, branch-local CI repair, queue-repair execution when requested |
| Merge Steward | Queue state, ordering, branch freshness policy, speculative branch construction, CI result classification, merge decisions, retry and eviction policy |
| GitHub | PR review truth, status check truth, merge truth |

## Design Principles

### Serial Integration First

Development may happen in parallel.
Integration should not.

Only one queue head per repository should be refreshed against the current base branch at a time.
Non-head queued PRs should remain frozen until the queue advances.

This avoids pointless full-CI reruns on branches that will become obsolete as soon as an earlier PR merges.

### Reconciliation, Not Ad Hoc Events

The steward should be implemented as a reconciliation loop:

```text
desired queue state
-> compare with actual GitHub / CI state
-> apply the minimal mutations
-> repeat
```

This keeps queue behavior restart-safe and idempotent.

### Agent Repair Is A Subroutine, Not The Queue Driver

The queue should not hand every failure directly to Codex.

Before starting repair, the steward must classify the failure:

- `main_broken` — current trunk is red; pause queue
- `flaky_or_infra` — retry checks without agent repair
- `branch_local` — PatchRelay may run `ci_repair`
- `integration_conflict` — PatchRelay may run `queue_repair`
- `policy_blocked` — waiting for approval, dirty branch, or explicit dequeue

### Queue State Must Be First-Class

PatchRelay's current single `issues.pr_number` field is not enough.

The system needs first-class queue records and PR-attempt history so it can answer:

- which PR attempt is currently active for an issue
- which queue entry is head-of-line
- which speculative branch corresponds to which ordered batch
- which repair attempts were already tried for a given `head_sha` and `base_sha`

## Steward Model

## Queue Entry Lifecycle

```text
queued
-> waiting_head
-> preparing_head
-> validating
-> passed
-> merging
-> merged

failure paths:
validating -> repair_requested
validating -> evicted
validating -> paused
preparing_head -> repair_requested
```

Suggested queue-entry statuses:

- `queued`
- `waiting_head`
- `preparing_head`
- `validating`
- `repair_requested`
- `repair_in_progress`
- `paused`
- `evicted`
- `merged`

## Phase 1: Strict Serial Steward

The first production version should be simple:

1. Accept approved PRs with green branch CI into the queue.
2. Select the queue head.
3. Refresh only that PR against the latest base branch.
4. Run required CI for that refreshed head.
5. If green, merge it.
6. Advance to the next queued PR.

This phase delivers the main operational win:

- no parallel branch refresh
- no redundant retesting of non-head PRs
- clear ownership of queue progress

## Phase 2: Speculative Validation

Once the serial steward is stable, add speculative cumulative branches:

```text
main + A
main + A + B
main + A + B + C
```

The purpose of these branches is validation, not authorship.
They are temporary queue artifacts that let the steward learn whether downstream items are likely to pass after upstream merges.

Important rule:

- do not rely on merging the speculative branch itself as the repository-facing source of truth

The default landing path should still be to merge the actual queued PR at the head once its validated state is satisfied.

## Phase 3: Failure Isolation And Independent Lanes

After speculative validation works reliably:

- use binary bisection for failing cumulative batches
- optionally add file-path or target-based conflict lanes for independent PRs

Until then, one queue lane per repository is the default.

## Repair Handoff Contract

When the steward needs PatchRelay to repair an item, it should send a typed repair request rather than a vague "fix CI" instruction.

Suggested contract:

```ts
interface QueueRepairContext {
  queueEntryId: string;
  issueId: string;
  prNumber: number;
  prHeadSha: string;
  baseSha: string;
  failureClass: "branch_local" | "integration_conflict";
  failedChecks: Array<{
    name: string;
    url?: string;
    conclusion: "failure" | "timed_out" | "cancelled";
  }>;
  baselineChecksOnMain: Array<{
    name: string;
    conclusion: "success" | "failure";
  }>;
  isolatedDiffSummary?: string;
  compoundDiffSummary?: string;
  queuePosition: number;
  aheadPrNumbers: number[];
  behindPrNumbers: number[];
  priorAttempts: Array<{
    at: string;
    kind: "ci_repair" | "queue_repair";
    summary?: string;
    outcome: "failed" | "succeeded" | "abandoned";
  }>;
  attemptBudget: {
    current: number;
    max: number;
  };
}
```

The steward should never ask PatchRelay to repair blindly.

## Data Model

The steward should keep its own SQLite database.

Suggested tables:

- `queue_entries`
  - one row per PR entering the queue
  - includes status, priority, position, current head/base SHAs, attempt counters
- `pr_attempts`
  - one row per observed PR incarnation or synchronized head SHA
- `speculative_branches`
  - desired vs actual speculative branches and CI status
- `check_snapshots`
  - normalized required-check results per `(branch, head_sha, base_sha)`
- `repair_requests`
  - requests sent to PatchRelay and their outcomes
- `queue_events`
  - append-only audit trail for operator visibility

PatchRelay should eventually retain a matching `pr_attempts` concept so issue history is not collapsed to one PR pointer.

## Integration With PatchRelay

### From PatchRelay To Steward

PatchRelay notifies the steward when:

- a PR becomes approved and branch-green
- a PR is updated and must be re-evaluated
- a PR is closed or merged outside the queue
- a repair run completes

### From Steward To PatchRelay

The steward asks PatchRelay to:

- run `ci_repair` for a branch-local failure
- run `queue_repair` for an integration conflict
- cancel stale repair attempts when the queue context changes

## Required Invariants

The steward must preserve these invariants:

1. `main` only advances from validated queue states.
2. At most one queue head is in refresh / validation at a time per repository.
3. Every queued PR is either active, merged, evicted, paused, or explicitly removed.
4. Reconciliation is idempotent.
5. Repair attempts are bounded per failure class and per queue context.
6. A newer head SHA invalidates older repair attempts for the same PR.

## Testing Strategy

The steward should be built with a deterministic simulation harness before production rollout.

Recommended stack:

- `isomorphic-git`
- `memfs`
- `fast-check`

The harness should model:

- queue ordering
- speculative branch creation
- conflicts
- CI pass/fail/flaky outcomes
- dequeue and reprioritization
- crash recovery and repeated reconciliation

The goal is to prove queue invariants without depending on live GitHub or live CI.

## Migration Plan

1. Freeze PatchRelay's built-in merge-prep logic as legacy behavior.
2. Introduce `merge-steward` as the sole queue owner for new projects.
3. Keep PatchRelay's queue-repair run type, but only as an execution target invoked by the steward.
4. Move queue ordering, queue retries, and freshness decisions out of PatchRelay.
5. Retain GitHub webhooks as canonical state input for both services.

## Summary

PatchRelay should remain the deterministic harness around agentic development.
The merge queue should become a separate deterministic harness around integration.

That split keeps the model where it helps and removes it from the part of the system that most needs simple, restart-safe, auditable control.
