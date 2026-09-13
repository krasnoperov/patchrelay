# Review Quill

Review Quill supplies two deliberately different gates:

1. substantive feature review on a PR head;
2. narrow integration-preservation review on a candidate that PatchRelay
   changed after approval.

It is read-only with respect to repository contents and publishes all verdicts
through GitHub.

## Responsibility split

| System | Owns |
|-|-|
| PatchRelay | Feature implementation and repairs in feature or candidate workspaces. |
| Review Quill | Feature correctness verdicts and integration-preservation verdicts. |
| Merge Steward | Candidate construction, speculative order, validation, and landing. |
| GitHub | PR, review, ref, ancestry, and SHA-bound check truth. |

No service calls another service's API. Push and check webhooks wake Review
Quill; current GitHub state determines whether either review is needed.

## Feature review

For each reviewable PR head, Review Quill asks:

> Is this feature implementation correct and consistent with its stated and
> repository contracts?

The attempt is keyed to repository, PR, and exact head SHA and publishes an
ordinary GitHub `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`. A newer feature
head supersedes an older in-flight attempt.

`patch_id` is a limited carry-forward optimization: an identical feature patch
may reuse an approved verdict, while a changed patch receives fresh substantive
review. Once an approved head enters integration, target-branch movement alone
does not reopen feature review.

## Integration review

Review Quill watches self-describing refs:

```text
merge-steward/<base-branch>/pr-<number>
```

A mechanically generated clean candidate needs candidate CI but no second
feature review. When PatchRelay changes a candidate after a merge conflict or
candidate-test failure, Review Quill asks:

> Does this candidate still contain the already-approved feature with the same
> behavior and contract, while correctly composing it with the prospective
> base?

The context contains:

- the frozen approved PR head and its feature review;
- the prospective base;
- changes introduced on the base since the feature branch diverged;
- the repaired candidate and its exact diff/ancestry;
- relevant repository guidance and candidate test results.

The output is the `review-quill/integration` check on the exact candidate SHA:

- `success` — the integration repair preserved the approved feature;
- `failure` — the repair materially changed feature behavior or contract and
  the PR must return to implementation.

This is not a new architecture review of the feature. Prior approved concerns
remain closed unless the integration repair changed the corresponding code or
contract.

## Material-change boundary

Integration review fails when the candidate changes feature acceptance
criteria, public API, schema, security, billing, persistence, permissions,
error behavior, or feature-owned test expectations. Conflict composition,
imports adapted to the new base, canonical regeneration of derived files, and
test repair that preserves the approved behavior may pass.

Tests and textual conflict resolution are evidence, not proof by themselves;
the reviewer inspects the interaction surface when an agent changed it.

## Eligibility and reconciliation

Feature review is eligible when the PR is open, non-draft, and has a new
reviewable head. Integration review is eligible when:

- a candidate ref maps to an open PR with any effective approval on its exact
  current head, including a human approval;
- the candidate contains the frozen approved head;
- PatchRelay authored changes in the candidate;
- no decisive integration check covers the current candidate SHA.

Webhooks are never authoritative. Startup and periodic reconciliation reproduce
the same eligibility decision from GitHub refs, ancestry, commits, reviews, and
checks.

## Runtime shape

Each attempt materializes an ephemeral checkout at the exact reviewed SHA,
loads repository guidance, runs Codex with the correct review scope, validates
structured output, publishes through the GitHub App, and disposes of the
workspace. A stale SHA is never published.

## Publication and landing rules

- Feature verdicts are ordinary GitHub PR reviews on the feature head.
- Integration verdicts are `review-quill/integration` checks on candidate
  SHAs.
- A successful integration check is reusable only for that exact SHA.
- Merge Steward may land an agent-modified candidate only when that check and
  required candidate CI are green.
- A failed integration check returns the work to the feature track; ordinary
  candidate CI failure remains repairable inside integration.

## Non-goals

- fixing or pushing code;
- owning queue order or landing;
- re-reviewing an unchanged feature because `main` advanced;
- using labels, comments, or direct service calls as workflow commands.
