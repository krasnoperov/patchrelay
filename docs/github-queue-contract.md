# GitHub Queue Contract

PatchRelay and Merge Steward are intentionally decoupled services. GitHub is the protocol boundary between them.

This document is the contract for that boundary.

## Shared Primitives

- Repository: `repoFullName`
- Base branch: `baseBranch`
- Pull request identity: `prNumber`, branch name, `headSha`, `baseSha`
- Review state: approved, changes requested, commented
- Check state: passed, failed, pending
- Merge state: open, closed, merged

## Shared Control Artifacts

- Eviction check run:
  Merge Steward emits this on queue eviction.
  PatchRelay interprets it as a queue-repair request rather than ordinary CI failure.
  Default: `merge-steward/queue`

- Optional compatibility label:
  Some repos may still carry a `queue` label or similar metadata.
  PatchRelay does not rely on it for scheduling, and Merge Steward admission should not require it.

## Ownership

- PatchRelay owns:
  - branch implementation
  - review fixes
  - branch-local CI repair
  - queue repair after steward eviction
  - Linear-facing operator and session UX

- Merge Steward owns:
  - queue admission
  - branch freshness
  - validation retries
  - merge execution
  - eviction classification and incident creation

## Required GitHub Events

- PatchRelay:
  - `pull_request`
  - `pull_request_review`
  - `check_suite`
  - `check_run`
  - `push`

- Merge Steward:
  - `pull_request`
  - `pull_request_review`
  - `check_suite`
  - `push`

## Failure Contract

- Ordinary branch CI failure:
  - produced by normal PR checks
  - PatchRelay routes to `ci_repair`

- Queue eviction:
  - produced by Merge Steward as the configured eviction check run
  - PatchRelay routes to `queue_repair`
  - PatchRelay persists queue-failure provenance so reconciliation can preserve the distinction after webhook delivery
  - the eviction check run should carry structured incident detail in `output.text` plus an incident details URL so PatchRelay can preserve richer repair context

## Observability Contract

- PatchRelay should expose:
  - configured eviction check name
  - last observed queue/failure signal

- Merge Steward should expose:
  - incident detail for evicted entries
  - emitted eviction check run name
  - current required checks / admission facts from GitHub truth

## Defaults

- Eviction check run: `merge-steward/queue`

Changing the eviction check name must be treated as a protocol change and updated on both sides.

## Review carry-forward

Review-quill caches approved verdicts so a head SHA change that does not change
the patch (rebase onto fresh main, force-push of the same content, etc.) does
not trigger a fresh review run. The cache key is the change identity:

- `patch_id` — `git diff $(git merge-base <base> <head>)..<head> | git patch-id --stable`
- `integration_tree_id` (deferred) — `git merge-tree --write-tree <base> <head>`

`--stable` canonicalizes per-file order so commit reorders within a range
produce the same id. The output is a tree object id; non-zero exit from
`git merge-tree` signals a real conflict, not an error.

Two review surface modes coupled to two cache shapes:

- `head` (v1 default) — reviewer reviews the PR head; cache keys on `patch_id`
  alone. Trivial rebases carry forward; semantic merge issues are caught at
  integration time by the lander's spec CI.
- `integration_tree` (deferred) — reviewer reviews the synthetic merged tree;
  cache keys on `(patch_id, integration_tree_id)`. Most base-advance rebases
  re-review.

Mixing modes with the wrong cache key produces incorrect carry-forward, so
`review_surface_mode` is recorded on every `review_attempts` row and the
lookup filters on it.

A PR carrying the configured no-cache label (default `review:no-cache`) is
always re-reviewed even when the patch is unchanged — useful for release /
changelog PRs that need a fresh body rendering.

Carry-forward only fires for stored verdicts that include the rendered review
body and event. Rows from before the carry-forward migration have NULL bodies
and naturally fall through to a fresh review (rollout safety).
