# Review Quill

`review-quill` is the dedicated PR review service in the PatchRelay stack.

It answers one narrow question for each reviewable PR head:

- should this exact head SHA be approved or receive requested changes?

The service is separate from:

- `patchrelay`, which owns delegated implementation and branch upkeep
- `merge-steward`, which owns queue admission, speculative validation, and landing

For install and operator commands, see [../review-quill.md](../review-quill.md).

## Responsibility Split

| System | Owns |
|-|-|
| PatchRelay | delegated implementation, review-fix runs, branch-local CI repair, queue repair |
| review-quill | review eligibility, review execution, verdict publication, review reconciliation |
| merge-steward | merge gate admission, queue lifecycle, speculative validation, landing |
| GitHub | PR truth, review truth, status-check truth, branch protection |

## Core Contract

Each review attempt is keyed by:

- repository
- PR number
- head SHA

Review attempts are fresh, read-only, and tied to one PR head. If a newer head appears before publication, the old attempt is cancelled or superseded rather than publishing stale feedback.

The service publishes:

- an ordinary GitHub PR review: `APPROVE` or `REQUEST_CHANGES`
- a `review-quill/verdict` check run when configured for deterministic branch protection

`review-quill/verdict` is optional unless a repository makes it part of required checks. `merge-steward` can admit from GitHub PR review truth plus configured required checks, then performs its own integrated CI gate before landing.

## Eligibility

Eligibility is always recomputed from fresh GitHub truth.

By default, a PR head is reviewable when:

- the PR is open
- the PR is not draft
- the head SHA is known
- the branch is not excluded
- no current valid review-quill attempt already covers that head

Repositories may opt into `waitForGreenChecks`, in which case configured required checks must be settled green before review.

Do not treat a single webhook as authoritative. Webhooks wake reconciliation; GitHub truth decides eligibility.

## Runtime Shape

Each review attempt:

1. materializes an ephemeral checkout at the exact PR head SHA
2. builds local diff context against the base branch
3. loads repo review guidance
4. starts a fresh Codex app-server review thread
5. parses a structured verdict
6. publishes through the service, not directly from the model
7. disposes of the temporary workspace

The durable runtime record is the review attempt, not a long-lived issue session.

Do not use PatchRelay-style thread steering for reviews.

## Prompt Context

The review prompt should include:

- PR title and body
- base branch
- current head SHA
- curated local diff
- prior formal PR reviews as concise claims to verify
- repo guidance docs, normally `REVIEW_WORKFLOW.md`, `CLAUDE.md`, and `AGENTS.md`
- detected issue keys from PR title, body, or branch

The prompt must keep GitHub truth authoritative and review only the current head SHA.

## Diff Context

Build diff context locally from the checked-out repository:

- file inventory from `git diff <base>...HEAD`
- reviewable patches within budget
- summarized entries for generated, noisy, or oversized files

Common summarize-only paths include lockfiles, `dist/**`, `build/**`, `coverage/**`, maps, minified JS, and snapshots.

## Publication Rules

For an eligible PR head, publish one of:

- `APPROVE`
- `REQUEST_CHANGES`

Review output should separate blocking findings from non-blocking notes and ground findings in the current diff.

Before every side effect, re-check that:

- the attempt still owns its lease
- the PR still points at the reviewed head SHA
- the attempt has not been superseded

## Data Model

The service stores only workflow truth:

- webhook deliveries for dedupe
- repository config
- review attempts
- external check-run ids
- append-only review events
- Codex thread ids for forensic lookup

Raw Codex transcripts stay in Codex session files; see [codex-session-source-forensics.md](./codex-session-source-forensics.md).

## Non-Goals

- direct code fixes
- committing or pushing
- merge queue ownership
- cross-repo review batching
- stack-aware review semantics
- human reviewer assignment workflows
