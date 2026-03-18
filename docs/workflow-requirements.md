# Workflow Requirements

## Purpose

This document captures the desired end-to-end behavior for delegated PatchRelay issue execution
across repo-defined workflow stages such as `implementation`, `review`, and `deploy`.

It is intentionally about behavior, not wire format. In particular:

- it does not require a structured stage-outcome payload yet
- it does not choose the exact persistence model yet
- it does not choose the exact prompt/handoff encoding yet

The goal is to make the required pipeline behavior explicit before choosing the implementation
details.

## Behavioral Framing

PatchRelay should behave like a pipeline runner, not like a single long-lived coding prompt.

Stage transitions should be automatic and deterministic when workflow policy makes the next step
clear.

Architecture, persistence, and execution-layer responsibilities are specified separately in
[orchestration-requirements.md](orchestration-requirements.md). Workflow selection, transition
evidence, and stage prompt expectations are specified separately in
[workflow-selection.md](workflow-selection.md), [transition-evidence.md](transition-evidence.md),
and [stage-prompt-contract.md](stage-prompt-contract.md).

## Problem Statement

Today PatchRelay can run a single delegated stage well, but it still tends to stop between stages
and wait for another human prompt in Linear.

That is not the desired operator model.

For a delegated issue, PatchRelay should behave like a pipeline runner:

- implementation should flow into review automatically when implementation is ready
- review should flow into deploy automatically when review approves the branch
- review should return to implementation automatically when review finds fixable issues
- deploy should return to implementation automatically when deploy finds fixable issues
- the pipeline should stop only at real terminal states such as `Done` or `Human Needed`

The human should not need to manually re-prompt PatchRelay between normal stages of the same
delegated issue lifecycle.

## Workflow Shape Requirements

PatchRelay should not assume that every repo always uses the exact same stage set.

The orchestration model should therefore be:

- deterministic at the control level
- configurable at the workflow-policy level
- agentic inside each active stage

This means:

- PatchRelay should own a deterministic workflow graph
- repos should be able to define which stages exist and which transitions are allowed
- `implementation -> review -> deploy` should be the default backbone, not the only possible shape
- extra stages such as `triage`, `qa`, `staging_deploy`, `prod_deploy`, `verification`,
  `rollback`, or `acceptance` should be possible when repo policy requires them

PatchRelay should not let an agent invent arbitrary top-level workflows per issue. The set of
stages and transitions must remain explicit, inspectable, and testable.

The simplest useful starting point is:

- one default workflow backbone: `implementation -> review -> deploy`
- optional repo-level overrides only when a repo truly needs extra stages or a different path

PatchRelay should not require a fully dynamic workflow engine in order to support repo-specific
variation.

## Delegated Session Model

One delegated Linear agent session should be able to own the whole issue pipeline.

Desired behavior:

- a delegated session starts the first runnable stage for the issue
- PatchRelay keeps the same Linear agent session as the human-facing conversation surface across
  later stages
- stage changes inside that delegated session should normally continue automatically
- the session should remain inspectable and readable as one issue-local execution story

PatchRelay may still use different Codex turns or threads internally between stages. The requirement
is continuity of issue ownership and user-visible delegation behavior, not one single internal turn
forever.

## Default Workflow Transition Requirements

The transitions below describe the default feature-style workflow:

- `implementation -> review -> deploy`
- with loops back to earlier stages when findings are fixable

Repos may define other workflow shapes, but this default backbone should be supported well.

### Implementation -> Review

When implementation finishes and the branch is honestly review-ready, PatchRelay should:

1. move the issue to `Review`
2. preserve the implementation evidence needed for review
3. start review automatically if the issue is still delegated to PatchRelay and no human override
   is present

PatchRelay should not require a new human prompt just to start review in the normal case.

### Review -> Deploy

When review approves the branch for shipping, PatchRelay should:

1. move the issue to `Deploy`
2. preserve the review conclusion and verification context needed for deploy
3. start deploy automatically if the issue is still delegated to PatchRelay and no human override
   is present

PatchRelay should not require a new human prompt just to start deploy in the normal case.

### Review -> Implementation

When review finds fixable issues that belong to implementation, PatchRelay should:

1. move the issue back to `Start`
2. preserve the concrete review findings and pickup context
3. start a new implementation pass automatically if the issue is still delegated to PatchRelay and
   no human override is present

The next implementation pass should begin with the review findings already in scope. The operator
should not need to copy review comments back into a new prompt manually.

### Deploy -> Implementation

When deploy finds fixable issues that belong to implementation, PatchRelay should:

1. move the issue back to `Start`
2. preserve the deploy diagnostics, failing checks, and relevant environment evidence
3. start a new implementation pass automatically if the issue is still delegated to PatchRelay and
   no human override is present

The next implementation pass should begin with the deploy findings already in scope.

### Deploy -> Review

When deploy finds an issue that is not a code-fix implementation problem, but rather a review or
approval readiness problem, PatchRelay may return the issue to `Review` instead of `Start`.

This should be reserved for cases where:

- the code itself is likely correct
- the issue is blocked on review/deploy readiness rather than implementation work
- sending the issue back to implementation would create unnecessary churn

If PatchRelay routes deploy back to review, it should preserve:

- the exact deploy precondition or readiness issue that blocked progress
- the evidence showing that implementation is likely not the problem
- the branch, PR, and verification context review needs to reassess ship readiness

### Any Stage -> Human Needed

PatchRelay must stop and move to `Human Needed` when:

- a human decision is required
- the correct next stage is ambiguous
- retry limits or time limits for automatic continuation have been exceeded
- ownership changed or delegation was removed
- repo policy says the agent must not guess

## Continuation Requirements

Automatic continuation is allowed only when all of the following are true:

- the issue is still delegated to PatchRelay
- the issue state change was made by the running stage as part of a normal handoff
- there is a clear next stage implied by that handoff
- there is enough carry-forward context for the next stage to start safely
- no human has interrupted or redirected the issue in the meantime

Automatic continuation should be suppressed when:

- the delegate changed away from PatchRelay
- a human moved the issue to an unrelated state
- a human added conflicting instructions mid-transition
- the next stage would require guessing through missing context

## Carry-Forward Context Requirements

Stage transitions must preserve enough context for the next stage to act without manual
reconstruction.

Required examples:

- implementation -> review:
  - what changed
  - what was verified
  - branch/PR/head SHA context
- review -> implementation:
  - concrete findings
  - why each finding matters
  - where implementation should pick up
- review -> deploy:
  - approval decision
  - relevant verification evidence
  - what should be watched during deploy
- deploy -> implementation:
  - failing deploy/run links or identifiers
  - environment and verification failures
  - exact reason the issue is going back
- deploy -> review:
  - the specific readiness or approval issue that blocked deploy
  - the evidence showing implementation is likely not the missing piece
  - the branch, PR, and verification context review needs to reassess ship readiness

The format is deliberately unspecified here. The requirement is continuity of execution context, not
any one encoding.

PatchRelay should prefer the smallest carry-forward packet that lets the next stage act safely. It
does not need a large or rigid handoff protocol to satisfy this requirement.

See [transition-evidence.md](transition-evidence.md) for the minimum evidence expected for default
workflow transitions.

## User-Facing Session Behavior

PatchRelay should keep the Linear agent session updated when it changes stages.

Examples of desirable user-visible messages:

- implementation completed, starting review
- review found 2 fixable issues, returning to implementation
- review approved the branch, starting deploy
- deploy failed on a fixable issue, returning to implementation
- stopping at `Human Needed` because a product/release decision is required

The Linear session should read like one continuous delegated workflow, not like unrelated isolated
stage runs.

The Linear session plan UI should be used as a human-facing projection of the current workflow and
active stage progress. It is useful for visibility, but it is not the controller. Architectural
ownership of plan state is described in [orchestration-requirements.md](orchestration-requirements.md).

PatchRelay may publish:

- high-level workflow plan items such as `Implementation`, `Review`, `Deploy`
- active-stage substeps when useful

But actual stage transitions must still be controlled by PatchRelay, not by whatever checklist is
currently shown in Linear.

## Loop Safety Requirements

Automatic looping is valuable, but it must be bounded.

PatchRelay should include guardrails such as:

- a maximum number of automatic implementation/review/deploy retries for the same issue
- a maximum wall-clock duration for stage execution
- escalation to `Human Needed` when those limits are exceeded

The pipeline should optimize for safe forward progress, not infinite persistence.

`Human Needed` should remain the simple and preferred escape hatch whenever the next automatic step
is unclear or unsafe.

## Deploy Preconditions

Deploy should only proceed when deploy-owned preconditions are truly satisfied.

Examples:

- the reviewed branch is in the required merge-ready state for that repo
- required PR and CI gates are green
- the deploy stage has a real shipped target to watch

If deploy preconditions are not met, PatchRelay should route the issue back to the stage that owns
the missing requirement instead of pretending deploy is in progress.

## Repo Workflow Expectations

Repo-local workflow docs should stay aligned with this behavior.

Repo workflow docs should not assume that humans will manually restart PatchRelay between normal
stages of the same delegated issue lifecycle.

Repo workflow policy should define:

- which workflow shapes exist for that repo
- which stages exist for that repo
- which Linear states map to which workflow stages
- which transitions are allowed
- when implementation is allowed to hand off to review
- when review is allowed to hand off to deploy
- when review should send work back to implementation
- when deploy should send work back to implementation or review
- what evidence must be carried forward at each handoff
- when automatic continuation is allowed
- when the pipeline must stop at `Human Needed`

## Non-Goals

This document does not yet require:

- one specific structured handoff schema
- one specific SQLite schema change
- one specific event or obligation type
- one specific agent prompt format
- one universal hardcoded workflow shape for every repo

Those are implementation choices to make after the desired behavior is accepted.
