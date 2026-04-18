# Merge Queue Runbook

This document explains how the shipped delivery pipeline behaves in practice, what kinds of failures it handles well, where human or agent judgment is still required, and what operators should look at when something goes wrong.

Use this alongside:

- [GitHub queue contract](./github-queue-contract.md) for the shared protocol
- [PR delivery pipeline](./merge-queue.md) for setup and high-level lifecycle
- [Merge queue operations recommendations](./design-docs/merge-queue-operations.md) for broader design guidance and future ideas

## Service split

Three services are intentionally separate, each with its own loop:

- **patchrelay** owns issue implementation, review fixes, branch-local CI repair, queue repair, and Linear-facing workflow UX
- **review-quill** owns PR review publication (approve / request changes)
- **merge-steward** owns queue admission, rebasing, validation, retries, merges, and eviction decisions

GitHub is the protocol boundary. No service calls another's API directly:

- `review-quill` publishes a normal GitHub review on each merge-ready head
- `merge-steward` admits PRs that GitHub shows as approved + green, then validates and lands or evicts
- `merge-steward` reports queue eviction via the configured GitHub check run
- `patchrelay` (or a supervising agent driving the [ship-pr](https://github.com/krasnoperov/patchrelay-agents) skill) interprets that check run as `queue_repair` rather than ordinary `ci_repair` and fixes the branch

This is healthy coupling. The services share GitHub primitives and queue semantics, but they do not call each other directly.

## 1. Happy Path

The happy path is deterministic and deliberately narrow:

1. PatchRelay finishes implementation and review/CI work for an issue branch.
2. The PR reaches `awaiting_queue`.
3. Merge Steward sees that the PR is approved and required checks are green.
4. Steward admits it to the queue.
6. The queue head advances through:

```text
queued → preparing_head → validating → merging → merged
```

At the head of the queue, Steward:

- fetches the latest base branch and PR head
- verifies the PR is still approved and still points at the expected SHA
- rebases the PR onto the current base branch
- pushes the refreshed branch
- waits for CI on the refreshed head SHA
- revalidates approval/head/base assumptions
- merges through GitHub when validation still holds

Non-head entries stay queued until they become eligible for preparation or speculation.

## 2. How Conflicts Are Handled

There are two distinct conflict classes.

### Mechanical conflict

This is a Git-level conflict during branch refresh:

- content conflict
- rename conflict
- binary conflict
- other rebase/merge integration conflict

Steward treats these as deterministic queue failures. It may retry within policy, but once retry budget is exhausted it evicts the PR and emits the configured eviction check run.

PatchRelay can then start `queue_repair`.

### Semantic conflict

This is the harder case:

- the branch rebases cleanly
- CI may fail only after integration against current main
- or CI passes but the correct product behavior is still ambiguous

Merge Steward does not try to solve semantic conflict in the queue controller. That is intentional. The queue should stay deterministic.

PatchRelay and humans handle semantic conflict during repair. The right stance is:

- one bounded repair attempt when the fix is clearly local
- quick escalation when the issue is a product decision, cross-PR contradiction, or ownership dispute

### Is automatic conflict repair safe?

It is safe enough for the chosen architecture, but not semantically guaranteed.

What makes it reasonable:

- Steward validates against the latest base branch
- queue repair happens on the real PR branch
- the repaired branch must pass CI again before re-admission

What it does not guarantee:

- that an apparently clean merge is conceptually correct
- that an agent can always distinguish a local implementation bug from a broader product contradiction

So the safe operating rule is:

- let the queue handle mechanical refresh and validation
- let PatchRelay or humans handle ambiguous integration reasoning

## 3. How Failures Are Handled

Steward classifies failures before deciding whether to retry, reset, or evict.

### Flaky or infrastructure failure

- retry CI without invoking agent repair
- do not immediately evict if the failure looks transient

### Branch-local failure

- the branch appears broken on its own, not because of queued changes ahead of it
- PatchRelay should treat this as ordinary `ci_repair`

### Integration conflict

- the branch fails because of its interaction with the current base branch or queue context
- PatchRelay should treat this as `queue_repair`

### Policy blocked

- approval was withdrawn
- PR state changed underneath the queue
- merge is no longer allowed for policy reasons

This is not an agent repair problem. The PR must be brought back into an admissible state first.

### Main broken

- the base branch is already red or otherwise invalid
- the queue should not keep trying to land work into a broken target

This is an operational gate, not a PR-local repair signal.

## 4. What Bigger-Picture Reasoning Belongs Where

Merge Steward should consider only bounded integration truth:

- base branch freshness
- PR head freshness
- required checks
- queue ordering
- whether speculative downstream work is still valid

Merge Steward should not try to reason about:

- product intent
- cross-team ownership disputes
- business-rule contradictions across multiple PRs
- whether two individually valid changes are collectively undesirable

PatchRelay and humans should consider the bigger picture during review and repair:

- does the needed fix actually belong to another queued PR?
- would the repair rewrite product intent rather than fix implementation?
- are repeated queue repairs happening because the branch is being asked to solve a broader architectural conflict?

The system should consider the bigger picture, but not inside the deterministic queue controller.

## 5. How Control Returns After Fixes

The repair handoff should be clean and observable:

1. Steward evicts a PR after retry policy is exhausted.
2. Steward records an incident and emits the configured eviction check run.
3. PatchRelay observes that check run, persists queue-failure provenance, and preserves the steward incident context for repair.
4. PatchRelay schedules `queue_repair`.
5. The repair run updates the PR branch and pushes a new head SHA.
6. When the branch is healthy again, PatchRelay returns the issue to `awaiting_queue` and pushes the repaired head SHA.
7. Steward re-admits the PR when GitHub truth says the PR is admissible again.

The important distinction is that PatchRelay should not treat queue eviction like ordinary branch CI failure. It now preserves that provenance so idle reconciliation can keep routing it back to `queue_repair`.

## 6. Speculative Validation

Speculation is a throughput optimization, not the source of truth.

What the current implementation does:

- builds cumulative speculative branches behind the queue head
- bounds speculation by `speculativeDepth`
- invalidates downstream speculative results when upstream state changes
- revalidates head/base/approval assumptions before merge

Why this is a good fit for the current architecture:

- the true merge decision is still made on the actual PR branch and current base SHA
- speculative work can reduce waiting without becoming the canonical landing artifact
- stale speculative results are discarded rather than trusted optimistically

What is not implemented today:

- batch bisection when a speculative chain fails
- independent queue lanes based on affected targets
- a more aggressive merge-group model where the speculative artifact itself becomes the landing decision

So the current speculative model is sound for a serial-first queue, but intentionally conservative.

## 7. What Operators Can See Today

Observability is split across PatchRelay, Merge Steward, GitHub, and Linear.

### PatchRelay

PatchRelay is the better cross-repository operator surface today.

It exposes:

- issue state and PR lifecycle
- agent run history
- queue-repair vs CI-repair routing
- configured queue incident check details
- last observed queue/failure signal
- public session status and operator APIs

Use PatchRelay first when you need to answer:

- why is this issue not progressing?
- did we route to `ci_repair` or `queue_repair`?
- what queue/steward fact most recently changed the session?
- what has the agent done so far?

### Merge Steward

Merge Steward is the best queue-truth surface for a single repository.

It exposes:

- current queue entries
- head-of-line state
- recent queue transitions
- per-entry incident history
- eviction detail
- queue APIs and repo-scoped watch UI

Use Merge Steward first when you need to answer:

- why was this PR evicted?
- what is the current head doing?
- is the queue blocked by base-branch health, policy, or integration failure?

### GitHub

GitHub remains the shared operational bus:

- labels indicate queue admission intent
- PR state and review state drive admission validity
- CI checks provide admission and validation truth
- the steward eviction check run is the repair handoff signal

### Linear

Linear is PatchRelay-facing only:

- issue progress
- plan/session visibility
- operator-facing delivery workflow

Merge Steward should stay independent of Linear.

### Several repositories

Current state:

- PatchRelay gives a broad cross-repository issue dashboard
- Merge Steward watch and detail views are still repo-scoped

That means multi-repo operations are possible, but the queue-specific view is not yet unified across repositories.

## 8. Current Gaps

The main gaps that still matter operationally are:

- no batch bisection when a speculative chain fails
- no independent queue lanes or affected-target scheduling
- no richer semantic-conflict evidence package yet
- no first-class manual pause or policy state in the queue model
- no unified multi-repository queue dashboard

These are real gaps, but they are not correctness failures in the current design. They are missing control and operator ergonomics on top of a sound serial queue core.

## Suggested Operator Workflow

When a queued PR fails to land:

1. Check PatchRelay to see whether the issue is in `awaiting_queue`, `repairing_queue`, or `repairing_ci`.
2. Confirm the last observed failure signal and check name.
3. Open Merge Steward queue detail for the PR to inspect the incident and recent queue transitions.
4. Decide whether the issue is:
   - ordinary branch CI breakage
   - mechanical integration conflict
   - semantic conflict that needs escalation
   - policy or approval drift
5. If PatchRelay is repairing, let it make one bounded attempt when the fix is clearly local.
6. Escalate quickly when the repair would require broader product or cross-branch decisions.

The queue should keep deterministic control. Ambiguity should move outward to the repair layer rather than inward into the queue controller.
