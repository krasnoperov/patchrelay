# Merge Steward

`merge-steward` is the dedicated merge queue service in the PatchRelay stack.

It owns queue ordering, speculative integrated validation, retry policy, landing, and eviction. PatchRelay owns branch repair when an agent is actually needed.

For install, GitHub App permissions, commands, API, and troubleshooting, see [../merge-steward.md](../merge-steward.md).

## Why It Is Separate

The merge queue is a deterministic control problem. It should keep making progress even when agent execution is unavailable, expensive, or degraded.

PatchRelay should not be both the coding harness and the queue controller. The split keeps:

- PatchRelay focused on issue worktrees, agent runs, repair, and Linear-facing UX
- merge-steward focused on GitHub truth, ordered integration, validation, landing, and eviction
- GitHub as the shared protocol boundary

## Responsibility Split

| System | Owns |
|-|-|
| PatchRelay | implementation, review fixes, branch-local CI repair, queue repair |
| merge-steward | queue state, order, speculative branch construction, CI result classification, merge decisions, retry and eviction |
| GitHub | PR review truth, status check truth, branch and merge truth |

Neither service calls the other's API.

## Queue Lifecycle

Queue entries move through:

```text
queued -> preparing_head -> validating -> merging -> merged
                       \-> evicted
queued -> dequeued
```

Statuses:

- `queued` — admitted and waiting in line
- `preparing_head` — fetching and building the speculative branch
- `validating` — CI running on the speculative SHA
- `merging` — revalidating and fast-forwarding `main`
- `merged` — terminal success
- `evicted` — terminal failure after retry budget, with incident and check run
- `dequeued` — manual non-destructive removal

## Speculative Validation

The steward builds cumulative speculative branches:

```text
main + A         -> CI
main + A + B     -> CI
main + A + B + C -> CI
```

These branches are validation artifacts. The landing operation fast-forwards `main` to the tested speculative SHA after revalidation.

Before landing, the steward verifies:

- the PR has not been merged or closed externally
- the reviewed PR head is still the expected head
- the speculative SHA is still a fast-forward from current `main`
- required checks are still valid
- policy still allows the push

When an upstream entry lands or fails, downstream speculative branches are reused or invalidated based on whether their assumptions still hold.

## Admission

The steward admits from fresh GitHub truth:

- PR is open
- review gate is approved
- required checks are green according to branch policy and repo config
- the head does not match the latest evicted head for that PR
- the branch is not excluded

The configured queue label is an admission nudge and manual control surface, not the only source of truth. Removing the admission label dequeues an active entry.

## Failure And Repair

The steward classifies failures before retrying or evicting:

- `main_broken`
- `flaky_or_infra`
- `branch_local`
- `integration_conflict`
- `policy_blocked`

After retry budget is exhausted, the steward:

1. records an incident in SQLite
2. emits the configured eviction check run, default `merge-steward/queue`
3. transitions the entry to `evicted`

PatchRelay observes that check run through GitHub and triggers `queue_repair` when the linked issue is still delegated. After repair, a fresh PR head is required before re-admission.

## Invariants

- `main` advances only to a tested speculative SHA.
- Reconciliation is idempotent and restart-safe.
- Retry attempts are bounded per entry.
- Repeated conflict retries are gated on base SHA changes.
- A newer PR head invalidates stale queue assumptions.
- Every active entry is either queued, preparing, validating, merging, merged, evicted, or dequeued.

## Data Model

The steward keeps its own SQLite database for queue truth:

- queue entries
- incidents
- transition events
- speculative branch metadata
- check-run and CI observations needed for revalidation

PatchRelay stores only enough queue provenance to route repair and explain issue state.

For current operational gaps, see [../merge-steward.md](../merge-steward.md#current-gaps).
