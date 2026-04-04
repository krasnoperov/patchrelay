# GitHub Review Shims

## Purpose

This document records the compatibility shims we added while moving PatchRelay's review hand-off to a label-based protocol.

It exists for two reasons:

- operators need to understand why the shipped review path is slightly more complicated than the ideal model
- future cleanup work needs explicit exit criteria so temporary compatibility layers do not quietly become permanent folklore

This is a design note for the current shipped system, not a claim that every shim below should live forever.

## Recovery Status

As of April 5, 2026:

- the Mafia backlog that triggered this work has drained completely
- the previously stuck PR batch was merged to `main`
- the live review-label protocol is running in production PatchRelay
- the repository workflows in Mafia and Usertold include the compatibility layers described below

That means this document is now in the "stabilization and cleanup" phase, not the "incident still in progress" phase.

## Context

The target protocol is intentionally simple:

1. PatchRelay waits for settled green branch CI.
2. PatchRelay adds the configured review label, default `needs-review`.
3. GitHub Actions runs AI review for that labeled PR.
4. Approval produces a normal GitHub review event.
5. PatchRelay observes approval and adds the queue label.
6. Merge Steward admits, validates, and merges.

The incident that forced this document was not a problem with the protocol itself.
It was a problem with the real GitHub and provider surfaces around that protocol:

- open PR branches may not see newly changed workflow files the way operators expect
- the Claude action's auth path behaved differently under the new trigger context
- the Claude action produced "approve" verdict comments reliably, but that did not always become a real `APPROVED` review state

The shims below exist to bridge those gaps while preserving the higher-level protocol.

## Current Shipped Review Hand-Off

Today the review hand-off has three layers:

- PatchRelay requests review by applying `needs-review` only after gate checks are green
- GitHub Actions runs the review workflow from the repository default branch context
- a workflow-side compatibility layer converts the AI verdict into a real GitHub review state when the provider action only leaves a comment

The architectural rule is still:

- labels are the protocol
- GitHub review state is the truth PatchRelay reacts to
- Merge Steward does not participate in review

## Shipped Shims

### 1. Base-Branch Workflow Shim

Shipped behavior:

- the AI review workflow runs on `pull_request_target` with `types: [labeled]`

Why it exists:

- during incident recovery, newly opened PRs and already-open PRs did not behave the same way when the workflow definition was changed on `main`
- using `pull_request_target` forces the workflow definition to come from the base branch, which made the label trigger reliable for already-open PRs as well

What this shim is protecting against:

- stale or divergent workflow definitions on long-lived PR branches
- recovery scenarios where the protocol changes on `main` but the stuck PRs were opened before that change

What we should assume:

- this may remain a good long-term choice even if the rest of the shims are removed
- it is only a "shim" in the sense that it was introduced to stabilize the migration, not because it is necessarily architecturally wrong

### 2. GitHub Token Export Shim

Shipped behavior:

- the workflow passes `github.token` into the Claude action input
- the workflow also exports `GH_TOKEN` and `GITHUB_TOKEN` in the action environment

Why it exists:

- the Claude action's own auth path was not sufficient in the new trigger context
- the review workflow could verify CI with `gh api`, but the provider action still failed or behaved inconsistently without explicit token exposure for subprocesses

What this shim is protecting against:

- auth differences between the outer workflow step and the action's internal subprocesses
- `gh pr review` or `gh api` calls inside the model session failing silently or degrading to comment-only behavior

Removal criteria:

- we can prove the provider action consistently propagates the needed GitHub auth into all subprocesses we rely on
- at least several canary PRs complete without the explicit environment export

### 3. Verdict Translation Shim

Shipped behavior:

- after the Claude action finishes, the workflow reads the most recent `github-actions` review comment
- if the comment body contains an AI verdict such as `**AI Review: Approve**`, the workflow submits a real GitHub review state with `gh pr review`

Why it exists:

- the Claude action was reliably producing review comments with approval language
- GitHub still recorded those as `COMMENTED`, not `APPROVED`
- PatchRelay correctly waits for real review state, so comment-only verdicts were not enough to continue the pipeline

What this shim is protecting against:

- provider-action behavior that is semantically correct for a human reader but not machine-actionable for PatchRelay
- repeated queue stalls caused by "approve" comments that never emit the `pull_request_review` approval webhook

What this shim is not:

- it is not the ideal long-term design
- it is a workflow compatibility layer that restores the machine-readable GitHub review truth PatchRelay already expects

Removal criteria:

- we observe the provider action submitting real `APPROVED` or `CHANGES_REQUESTED` reviews directly
- the translation step becomes redundant across multiple canary PRs

## Emergency Recovery Behavior

During the Mafia incident, one PR was manually approved after the workflow had already produced repeated "Approve" comments.

That manual approval was:

- useful for unblocking the backlog immediately
- not part of the desired steady-state protocol

Operators should treat that as an emergency override, not as normal operating procedure.

That override did its job:

- it unblocked the queue
- it let the queued backlog drain
- it confirmed that PatchRelay and Merge Steward behaved correctly once GitHub review state was genuinely `APPROVED`

But it should not be required for new PRs after stabilization.

## What Is Temporary vs Structural

Likely structural:

- label-triggered review hand-off
- PatchRelay waiting for settled green CI before adding `needs-review`
- PatchRelay clearing stale review labels on branch changes and repairs
- running the workflow from the base-branch definition if that continues to be the most reliable GitHub behavior

Likely temporary:

- explicit token-export workarounds whose only purpose is to paper over provider-action auth behavior
- comment-to-review-state translation after the AI action completes

## Follow-Up Plan

The next follow-up after recovery is:

1. Merge the PatchRelay branch that contains the review-label protocol into protected `main`.
2. Run one small canary issue through Mafia or Usertold and verify the full path without manual intervention:
   `green CI -> needs-review -> AI review -> approved review event -> queue -> merge`
3. Capture whether the canary still needs the verdict translation shim.
4. If the canary succeeds end-to-end:
   - keep the base-branch workflow choice if it remains the most reliable trigger
   - consider removing the explicit token-export shim first
5. Only remove the verdict translation shim after several consecutive PRs prove that the provider action emits native GitHub review states reliably.

Current status against that plan:

- the backlog drain is complete
- the next required action is the PatchRelay `main` merge
- after that, the highest-value validation step is one intentionally small canary PR

## Operator Checks

When this area breaks again, inspect in this order:

1. Does the PR have `needs-review` after CI is green?
2. Did an `AI Review` workflow run actually start?
3. Did the workflow finish with a successful AI verdict comment?
4. Did GitHub record a real `APPROVED` or `CHANGES_REQUESTED` review state?
5. Did PatchRelay react by clearing `needs-review` and adding `queue`?

If step 3 succeeds and step 4 fails, the problem is almost certainly inside the workflow/provider shim layer, not in PatchRelay's review-label protocol.
