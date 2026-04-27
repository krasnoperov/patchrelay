# Merge Queue Runbook

Use this when a PR is approved but has not landed, or when `merge-steward` evicts a queue entry.

For setup and the stack-level lifecycle, see [merge-queue.md](./merge-queue.md). For service configuration and commands, see [merge-steward.md](./merge-steward.md). For the shared GitHub protocol, see [github-queue-contract.md](./github-queue-contract.md).

## Service Boundary

The delivery loop is split on purpose:

- **PatchRelay** owns issue worktrees, implementation, review fixes, branch-local CI repair, queue repair, and Linear-facing state.
- **review-quill** owns PR review publication.
- **merge-steward** owns queue admission, speculative integration, integrated CI validation, retry, landing, and eviction.

The services do not call each other directly. GitHub is the protocol boundary: PR state, review state, checks, labels, branches, and check runs.

## Happy Path

1. A PR is open, approved, and has green required checks.
2. `merge-steward` admits it to the queue.
3. The steward builds a speculative integrated branch:
   - head entry: `main + A`
   - downstream entries: `main + A + B`, `main + A + B + C`, up to `speculativeDepth`
4. CI runs on the speculative SHA.
5. Before landing, the steward revalidates approval, head/base assumptions, required checks, and fast-forward safety.
6. The steward fast-forwards `main` to the tested speculative SHA.
7. Downstream speculative branches are reused or rebuilt depending on whether their upstream assumptions are still valid.

Queue states:

```text
queued -> preparing_head -> validating -> merging -> merged
                       \-> evicted
queued -> dequeued
```

## Failure Classes

`merge-steward` classifies failures before retrying or evicting:

| Class | Meaning | Normal owner |
|-|-|-|
| `flaky_or_infra` | transient CI or infrastructure failure | steward retries |
| `branch_local` | PR branch appears broken on its own | PatchRelay `ci_repair` or human |
| `integration_conflict` | branch fails only in the current integration context | PatchRelay `queue_repair` or human |
| `policy_blocked` | approval, branch protection, or PR state no longer allows landing | human or PR owner |
| `main_broken` | target branch is already unhealthy | operator |

Mechanical conflicts and integrated CI failures become queue incidents when retry budget is exhausted. The queue controller should stay deterministic; product or ownership ambiguity belongs in PatchRelay repair or human escalation.

## Repair Handoff

When a queue entry is evicted:

1. `merge-steward` records an incident in its database.
2. It emits the configured GitHub check run, default `merge-steward/queue`, on the PR.
3. PatchRelay sees that check run failure and routes it to `queue_repair`, not ordinary `ci_repair`.
4. The repair actor pushes a new PR head.
5. The steward refuses to re-admit the same evicted head, then re-admits after a fresh push once GitHub truth is approved and green again.

The repair actor can be PatchRelay, an agent using the `ship-pr` skill, or a human working directly on the branch.

## Operator Workflow

When a PR is stuck or evicted:

1. Run `merge-steward pr status` from the PR checkout, or `merge-steward queue show --pr <num>`.
2. Check whether the entry is queued, validating, merging, evicted, or not admitted.
3. If evicted, read the incident and failure class from `queue show`.
4. In PatchRelay, check whether the linked issue is `awaiting_queue`, `repairing_queue`, `repairing_ci`, or paused.
5. Let PatchRelay make a bounded repair attempt when the fix is clearly local.
6. Escalate when the repair requires a product decision, conflicting branch ownership, broken credentials, or repeated semantic failures.

Useful commands:

```bash
merge-steward dashboard
merge-steward pr status --wait
merge-steward queue status --repo <id>
merge-steward queue show --pr <num>
merge-steward doctor --repo <id>
merge-steward service logs --lines 100
```

PatchRelay-side commands:

```bash
patchrelay dashboard
patchrelay issue show APP-123
patchrelay issue watch APP-123
patchrelay issue open APP-123
```

## Current Gaps

Known limitations that affect operations:

- no batch bisection when a speculative chain fails
- no independent queue lanes by path or target
- limited semantic-conflict evidence beyond the incident payload and failing checks
- no first-class manual pause state in the steward queue model

These are ergonomics and throughput gaps, not reasons to bypass the queue. Keep landing decisions tied to the steward's tested integrated SHA.
