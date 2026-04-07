# PR Automation Loop

This is the shared contract between PatchRelay, Review Quill, Merge Steward,
and GitHub.

## Roles

- `patchrelay` updates the PR branch
- GitHub CI validates the raw PR head SHA
- `review-quill` reviews the latest green PR head SHA
- `merge-steward` admits eligible PRs and validates speculative integrated SHAs
- GitHub remains the source of truth for PR state, review state, and checks

## Normal Flow

1. PatchRelay or a human pushes commits to a PR branch
2. GitHub runs CI on that PR head SHA
3. When the PR is open, non-draft, and required checks are green, `review-quill`
   reviews that exact head SHA
4. When GitHub considers the PR approved and its required checks are green,
   `merge-steward` can admit it
5. `merge-steward` builds a speculative integrated branch:
   - queue head: `main + PR`
   - downstream entries: cumulative branches like `main + A + B`
6. CI runs on the speculative SHA
7. If the queue head's speculative SHA is still a fast-forward from current
   `main`, `merge-steward` fast-forwards `main` to that exact tested SHA

## Invalidation Rules

- A new commit pushed to the PR branch changes the head SHA
  - GitHub CI reruns on the new head
  - `review-quill` reviews the new head
  - GitHub can dismiss stale approvals if branch protection enables that
- A different PR merging ahead in the queue does not change later PR head SHAs
  - later reviews stay valid
  - `merge-steward` handles the new integration context through speculative
    branches instead of rewriting the original PR branches

## Gating

- GitHub PR review state is the primary approval gate
- Required checks are whatever the repo config and branch rules define
- `review-quill/verdict` is optional unless the repo explicitly requires it
- `merge-steward` performs an additional speculative integrated-branch CI gate
  before landing

## Failure Handling

- `review-quill` cancels or supersedes stale in-flight attempts if the PR head
  changes before publication
- `merge-steward` retries on conflicts/CI failures within budget, then evicts
  with a durable incident and queue check run
- PatchRelay can repair evicted or conflicted queue entries and re-admit them
