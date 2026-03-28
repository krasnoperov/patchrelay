# Merge Queue Operations Recommendations

## Purpose

This document captures:

- the current shipped behavior of PatchRelay + Merge Steward
- relevant GitHub and Git guidance for merge queues and branch integration
- recommended next steps for PatchRelay's delivery model

It is a recommendations document, not a claim that all of the items below are already implemented.

## Current Shipped Model

Today the repository is aligned around a two-service split:

- PatchRelay owns issue worktrees, agent execution, review fixes, CI repair, and queue repair
- Merge Steward owns queue admission, serial head processing, rebasing, CI wait, merge, and eviction

The shipped steward is still a strict serial queue:

- admission is label-based
- the queue head is rebased onto the base branch
- CI is awaited on the rebased head SHA
- the PR is merged through GitHub when validation passes
- failures are evicted and handed back to PatchRelay through a `merge-steward/queue` check run

Important implementation details in the current code:

- speculative execution is available in the standalone steward server path when `speculativeDepth > 1`
- the real git path uses `git rebase` directly in a mutable clone
- the steward merges through `gh pr merge` with either `merge` or `squash`
- PatchRelay repairs queue evictions by starting a `queue_repair` run after the steward check run fails

## External Guidance

### GitHub Merge Queue

GitHub's merge queue docs emphasize a few invariants that match this system well:

- a merge queue should validate a PR against the latest base branch and changes ahead of it in the queue
- CI must run on merge-queue-specific refs or events, not only on normal PR events
- queue ordering should remain deterministic and first-in-first-out unless an operator deliberately reorders it
- concurrent build fan-out is a throughput knob, not a correctness requirement
- merge groups should only land after required checks for the relevant combined changes have passed

For PatchRelay this means:

- the current serial head-only approach is a valid Phase 1 model
- speculative validation should be treated as a throughput optimization, not as the source of truth
- if we ever add speculative groups, the real landing decision should still be tied back to the actual PR branch and current base SHA

### Git Merge / Rebase Guidance

The Git docs matter here because merge-queue behavior is mostly a sequence of Git operations:

- `ort` is the default two-head merge strategy and is the right baseline for this product
- `ort` supports rename handling and defaults to `diff-algorithm=histogram` during merges
- the rebase merge backend is safer for branch refresh than the apply backend because it keeps full tree information and preserves directory rename detection
- `git merge-tree --write-tree` can perform the same merge computation without touching the working tree or index
- `merge.conflictStyle=zdiff3` gives more informative conflict markers than plain `merge`
- `rerere.enabled` can automatically reuse previously recorded conflict resolutions on repeated rebases and merges
- `git log --first-parent` and `--diff-merges=first-parent` are the most practical default history views for queue landing
- `--diff-merges=remerge` and `git range-diff` are especially useful when a queue repair rebases a branch or changes the effective merge result

## Recommended Git Model For PatchRelay

### 1. Keep Serial Head Ownership As The Default

Recommended default model:

1. Admit only approved PRs with passing required checks.
2. Process exactly one repository head at a time.
3. Refresh that head against the current base.
4. Validate the exact refreshed head SHA.
5. Merge only if the base SHA, head SHA, approval state, and required checks are still valid.

This matches the current delivery model:

- one owning agent per issue branch
- one durable worktree per issue
- reactive queue repair instead of speculative autonomous multi-branch repair

### 2. Prefer Merge-Backend Refresh And Preflight Merge Simulation

Recommended refresh sequence for the steward:

1. Fetch `origin/<base>` and the PR head.
2. Preflight with `git merge-tree --write-tree --name-only -z origin/<base> <pr-head>`.
3. If the preflight is clean, perform the real branch refresh with merge-backend rebase.
4. Push with `--force-with-lease`.
5. Wait for CI on the resulting head SHA.

Why:

- `merge-tree` gives conflict information without mutating the checkout
- it uses the same modern merge machinery as real merge operations
- it gives a cleaner place to classify mechanical conflicts before touching the branch
- it reduces unnecessary mutable rebase attempts in the steward clone

### 3. Default To Merge Commits For This Delivery Model

Recommended default merge method: `merge`.

Why `merge` fits PatchRelay better than `squash` as the default:

- one issue branch maps cleanly to one integration event
- first-parent history stays easy to audit
- merge commits work naturally with `--diff-merges=first-parent` and `--diff-merges=remerge`
- queue incidents and later reverts can point at an explicit landing commit

`squash` should remain a supported repo policy, but it is a policy override rather than the ideal default for this factory model.

### 4. Standardize Diff Modes For Humans And Agents

Recommended defaults:

- queue/timeline views: `git log --first-parent`
- landed merge inspection: `git show --diff-merges=first-parent`
- suspicious merge outcome inspection: `git show --remerge-diff`
- compare pre-repair vs post-repair branch: `git range-diff <old-range> <new-range>`

These modes fit the operating model:

- first-parent gives the cleanest "what landed, in what order" view
- remerge-diff is the best debugging view when the merge result itself is under question
- range-diff is the best review aid when rebases or queue repairs rewrite branch history

### 5. Turn On Conflict-Resolution Aids Deliberately

Recommended steward clone config:

- `merge.conflictStyle=zdiff3`
- `rerere.enabled=true`

Recommended initial safety stance:

- keep `rerere.autoUpdate=false` until we add explicit post-resolution verification

That gives the queue better repeated-conflict behavior without silently trusting reused resolutions in the index before the steward or PatchRelay has validated them.

## What To Do On Semantic Merge Conflicts

Mechanical conflict:

- Git reports a content, rename, binary, or directory conflict during merge simulation or rebase
- steward should evict with structured conflict metadata
- PatchRelay can usually attempt `queue_repair`

Semantic conflict:

- Git merges cleanly, but the refreshed branch fails behaviorally after integration or produces a result that is locally "clean" but product-wise contradictory

Recommended orchestrator behavior for semantic conflicts:

1. Treat them as integration failures, not normal branch-local CI failures.
2. Preserve the exact `(base_sha, pr_head_sha, refreshed_head_sha)` tuple in the incident.
3. Attach failed checks, merge-tree output, and a diff summary to the incident.
4. Allow exactly one agent repair attempt when the failure looks implementation-local.
5. Escalate quickly when the failure implies a product decision, conflicting business rule, or cross-PR ownership dispute.

Heuristics for immediate escalation:

- the branch merges cleanly but breaks a higher-level invariant without a clear local fix
- the fix would require changing behavior owned by another already-queued PR
- the agent would need to rewrite or reinterpret product intent rather than repair implementation
- repeated queue repairs fail against different base SHAs

In practice:

- "semantic conflict" should not mean "keep retrying until the model guesses right"
- it should mean "record the integration evidence, try once if the fix is local, then escalate"

## Gaps In The Current Repository

### Docs Gaps

1. The docs do not yet define a preferred merge method for the delivery model, even though the implementation already exposes `merge` vs `squash`.
2. The docs describe queue eviction context at a high level, but they do not define the minimum evidence package needed for semantic conflicts.
3. The docs do not standardize operator diff views such as first-parent, remerge-diff, and range-diff.
4. The docs should say explicitly that speculative validation is available only when the steward server is configured with `speculativeDepth > 1`.

### Code Gaps

1. The steward performs a mutable `git rebase` immediately instead of first using `git merge-tree` to classify conflicts without touching the checkout.
2. Merge revalidation does not re-check the current base SHA before merging; it only re-checks PR approval, merge state, and head SHA.
3. CI failure classification currently calls `classifyFailure(branchChecks, [])`, so production never supplies a real main-branch baseline during eviction.
4. Eviction context is too thin for semantic conflicts. It does not currently include refreshed head SHA, merge-tree conflict type, diff summary, or a bounded semantic-repair hint.
5. PatchRelay queue-repair prompts currently say "rebase onto latest main and fix conflicts," but they do not pass through the steward's structured incident JSON for richer repair behavior.
6. PatchRelay adds the queue label in two places. The duplication is survivable and mostly idempotent, but it still makes admission behavior less explicit than it could be.

### Test Gaps

1. Steward tests are strong on state-machine invariants, but there are no production-path tests for `git merge-tree` preflight because that path does not exist yet.
2. There are no tests that assert merge refusal when the base branch moves after validation but before final merge.
3. There are no tests that prove CI failure classification against a real main baseline.
4. There are no tests for semantic-conflict escalation policy at the PatchRelay boundary.
5. Queue integration tests in PatchRelay still reflect some ambiguity about whether `check_failed` in `awaiting_queue` is a normal CI transition or a queue-specific repair handoff.

## Recommended Next Steps

### Docs First

1. Update merge-steward docs to state clearly that Phase 1 production is serial-only and that `speculativeDepth` is inactive until a real speculative builder ships.
2. Document the recommended default merge method as `merge`, with `squash` as a repo-policy override.
3. Add an explicit "semantic conflict" incident contract: required evidence, retry budget, and escalation threshold.
4. Document standard operator diff commands for landed merges, repaired rebases, and suspicious queue outcomes.

### Then Code

1. Add a preflight merge-analysis layer using `git merge-tree --write-tree`.
2. Extend eviction context with refreshed-head metadata and merge-analysis details.
3. Revalidate base SHA immediately before merge and bounce the entry back to preparation if `origin/<base>` moved.
4. Feed real main-branch check snapshots into CI failure classification.
5. Pass the steward's structured incident JSON through to PatchRelay queue-repair runs, not just the check name and URL.
6. Collapse queue-label application into one owned path, or make the duplication an explicit idempotent helper with shared reporting.

### Then Tests

1. Add steward tests for merge-tree preflight clean vs conflict cases, including rename conflicts.
2. Add a race test for "base advanced after CI passed but before merge."
3. Add classification tests with real main baseline snapshots for `main_broken`, `branch_local`, and mixed failures.
4. Add PatchRelay tests that verify semantic-conflict incidents cause fast escalation after one bounded repair attempt.
5. Tighten queue integration tests so queue eviction behavior is asserted through the webhook-handler contract, not through ambiguous factory-state expectations.

## Source Notes

Primary sources used for these recommendations:

- GitHub Docs: managing a merge queue
- GitHub Docs: Actions `merge_group` event
- Git docs: `git-merge`
- Git docs: `git-rebase`
- Git docs: `git-merge-tree`
- Git docs: `git-config`
- Git docs: `git-log`
- Git docs: `git-range-diff`

Where this document recommends behavior not explicitly prescribed by those sources, it is an inference for PatchRelay's specific delivery model rather than a direct quote from the underlying documentation.
