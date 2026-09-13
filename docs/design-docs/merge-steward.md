# Merge Steward

Merge Steward is the deterministic integration reconciler in the PatchRelay
stack. It owns queue order, cumulative speculative candidates, exact-SHA
validation, and landing. It does not own feature implementation or substantive
feature review.

For the public GitHub protocol, see
[github-queue-contract.md](../github-queue-contract.md).

## Design boundary

Delivery has two tracks:

- PatchRelay and Review Quill iterate on the PR branch until its feature is
  approved and branch CI is green.
- Merge Steward freezes that approved head and integrates it with prospective
  `main` in a separate candidate workspace.

Moving `main`, resolving an integration conflict, or repairing candidate CI
must not rewrite the approved PR branch or cause another full feature review.

## Responsibilities

| System | Owns |
|-|-|
| PatchRelay | Feature implementation, feature-review fixes, branch-CI repair, and agent work inside an integration workspace. |
| Review Quill | Substantive feature review and narrow integration-preservation review. |
| Merge Steward | Admission, queue order, candidate refs, speculative ancestry, exact-candidate checks, invalidation, and landing. |
| GitHub | Shared PR, review, ref, ancestry, and check truth. |

No service calls another service's API. Webhooks wake reconcilers; GitHub state
determines every transition.

## Candidate chain

The queue lands serially and validates several entries in parallel:

```text
main + A         -> candidate A -> CI
main + A + B     -> candidate B -> CI
main + A + B + C -> candidate C -> CI
```

Every synthetic candidate is published at:

```text
merge-steward/<base-branch>/pr-<number>
```

The name is a stable GitHub identity understandable without the steward's
database. The candidate SHA is immutable evidence; the ref may move when its
prospective base or repair changes.

## Candidate states

```text
queued
  -> preparing
  -> blocked_integration
  -> validating
  -> repairing_integration
  -> validating
  -> landing
  -> merged
```

- `blocked_integration` means candidate construction conflicted. The workspace
  ref points at the prospective base and does not yet contain the approved head.
- `repairing_integration` means PatchRelay owns the next non-force candidate
  push after a conflict or settled candidate-CI failure.
- These states are non-terminal and retain queue position and feature approval.
- `dequeued` remains an explicit operator action.
- `superseded` records that the immutable admitted PR head changed. It is not
  an active queue entry; the new head must pass ordinary admission again.
- Terminal failure is limited to policy/product ambiguity, exhausted repair
  budget, or an integration review proving substantive feature change.

The named state may be persisted locally for observability, but the operational
truth is recoverable from candidate ancestry and checks.

## Conflict repair without messages

When automatic construction conflicts, Merge Steward publishes the workspace
at the prospective base and does not trigger candidate CI. PatchRelay derives
the need for repair because the ref exists but lacks the approved PR head in its
ancestry. It repeats the merge locally, resolves it, commits, and non-force
pushes the result.

Merge Steward alone may reset the ref when the train moves. PatchRelay never
force-pushes it, so an attempt based on stale ancestry is rejected by Git and
restarted from fresh GitHub truth.

## Candidate test repair

A settled required-check failure on a candidate containing the approved head is
also an integration-repair state. PatchRelay repairs the candidate rather than
the feature branch. A new candidate SHA reruns required candidate checks and,
because PatchRelay changed the candidate, receives narrow integration review.

When the candidate was the approved head itself and therefore had no synthetic
ref, Merge Steward creates the workspace ref at that head before PatchRelay
starts. Candidate-only repair can then proceed without changing the PR branch.

Infrastructure retry is allowed on the same SHA. Re-running an already-green
required suite for the same SHA and policy is not.

## Integration review

Mechanically generated clean candidates need candidate CI but no additional
feature review. Candidate commits authored by PatchRelay require the
`review-quill/integration` check on that SHA. This review decides only whether
the approved feature survived the integration repair.

A successful integration check returns the entry to validation. A failed check
means the feature itself must change: discard the candidate and return the PR to
the feature track for a new implementation head and substantive review.

## Speculative blocking and invalidation

For `A -> B -> C`:

- A may land while B is being repaired.
- B retains its queue position.
- C cannot land before B.
- If B had a candidate, C may finish speculative work already in progress.
- If repair changes B's SHA, C is invalidated and rebuilt on the new B.
- If B conflicted before a candidate existed, C waits because it has no valid
  prospective base.

The steward does not silently rebuild the train without B merely because B
needs ordinary integration work.

## Landing invariant

Immediately before landing, refresh and require:

- current PR head equals the approved frozen head;
- candidate contains that head;
- candidate descends from the current prospective base;
- required checks on the exact candidate SHA are green under current policy;
- integration review is satisfied when required;
- current `main` is an ancestor of the exact candidate SHA.

Then non-force push that SHA to `main`. A rejected push invalidates/rebuilds the
integration candidate only; it does not reopen feature review.

## Invariants

- `main` advances only to an exact tested candidate SHA.
- Feature branches are immutable while integrating.
- Base movement invalidates integration evidence, not feature approval.
- Conflict and candidate-test repair happen on candidate refs.
- PatchRelay never force-pushes candidate refs.
- Candidate ancestry and SHA-bound checks are sufficient for cross-service
  reconciliation after lost webhooks or restart.
- Downstream speculative candidates are reused only while their predecessor
  ancestry remains valid.
- The same required suite is not repeated for the same SHA and policy.
