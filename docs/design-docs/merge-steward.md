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

## Queue Entry Lifecycle (as shipped)

```text
queued → preparing_head → validating → merging → merged

failure: any state → evicted (after retry budget exhausted)
dequeued: non-destructive removal via API
```

Statuses:

- `queued` — waiting in line
- `preparing_head` — fetch + rebase onto base branch
- `validating` — CI running
- `merging` — revalidation + merge via GitHub API
- `merged` — done (terminal)
- `evicted` — failed after retries, incident created (terminal)
- `dequeued` — manually removed (terminal)

Design decisions that differ from the original proposal:

- `waiting_head` was removed — `queued` is sufficient for serial Phase 1
- `repair_requested` / `repair_in_progress` / `paused` were removed — the steward evicts on failure instead of orchestrating repair. PatchRelay observes the eviction via GitHub check run and repairs independently.
- Non-spinning conflict retries are gated on `lastFailedBaseSha` — the reconciler skips rebase when the base hasn't changed since the last conflict, preventing idle spinning.

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

**Status: shipped.** See `packages/merge-steward/` for the implementation.

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

## Eviction and Repair Contract (as shipped)

The steward does not call PatchRelay directly. When a PR fails after retries, the steward:

1. Creates a durable `IncidentRecord` in its SQLite database
2. Creates a `merge-steward/queue` GitHub check run with the incident context as JSON in `output.text`
3. Removes the admission label from the PR
4. Transitions the entry to `evicted`

PatchRelay observes the check run failure via its GitHub webhook handler and triggers `queue_repair` if the check name matches `mergeQueueCheckName` (configurable, default `merge-steward/queue`).

The incident context (`EvictionContext`) includes:

- `failureClass`: `main_broken`, `branch_local`, `integration_conflict`, or `policy_blocked`
- `conflictFiles`: files that conflicted during rebase (if applicable)
- `failedChecks`: CI checks that failed (if applicable)
- `baseSha`, `prHeadSha`, `queuePosition`
- `retryHistory`: previous retry attempts

Phase 2 may enrich this with `baselineTestResults` (main's check state) and `compoundDiff` / `isolatedDiff` (when speculative branches exist). Phase 1 does not have these because there are no compound branches.

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

The steward should also expose that queue state through a lightweight operator surface:

- a current snapshot of queue entries and head-of-line state
- recent queue events so humans can see how the queue is advancing
- per-entry detail with incidents and transition history
- safe controls such as manual reconcile and dequeue

PatchRelay should eventually retain a matching `pr_attempts` concept so issue history is not collapsed to one PR pointer.

## Integration With PatchRelay (as shipped)

The two services communicate only through GitHub. No direct API calls.

**PatchRelay → GitHub → Steward:**
- PatchRelay adds the `queue` label (configurable via `mergeQueueLabel`) when an issue enters `awaiting_queue`
- GitHub sends a `pull_request.labeled` webhook to the steward
- The steward admits the PR if it's approved + CI green

**Steward → GitHub → PatchRelay:**
- The steward creates a `merge-steward/queue` check run on eviction
- GitHub sends a `check_run` webhook to PatchRelay
- PatchRelay triggers `queue_repair` if the check name matches `mergeQueueCheckName`
- After repair, PatchRelay re-adds the `queue` label → steward re-admits

**Steward → GitHub (success):**
- The steward merges the PR via `gh pr merge`
- GitHub sends `pull_request.closed` (merged) to PatchRelay
- PatchRelay transitions the issue to `done`

## Required Invariants

1. `main` only advances from validated queue states.
2. At most one queue head is in refresh/validation at a time per repository.
3. Every queued PR is either active, merged, evicted, or explicitly dequeued.
4. Reconciliation is idempotent.
5. Retry attempts are bounded per entry. Conflict retries are gated on base SHA change.
6. A newer head SHA (external push) invalidates the current entry state.

## Testing Strategy (as shipped)

The harness uses:
- `isomorphic-git` + `memfs` for in-memory git operations
- `fast-check` for property-based testing (800+ random runs)
- 6 invariant assertions checked after every state transition

50 tests cover: happy path, conflict chains, CI recovery, flaky tolerance, non-spinning retry, branch ownership, crash recovery, SQLite persistence, interleaved enqueue, eviction reporting, webhook admission.

## Migration Status

1. ~~Freeze PatchRelay's built-in merge-prep logic~~ → **Done.** `MergeQueue` class and `pendingMergePrep` field deleted.
2. ~~Introduce merge-steward as sole queue owner~~ → **Done.** Deployed as `packages/merge-steward/`.
3. PatchRelay's `queue_repair` run type is retained as the repair execution target.
4. ~~Move queue ordering out of PatchRelay~~ → **Done.**
5. GitHub webhooks are the canonical state input for both services. ✓
