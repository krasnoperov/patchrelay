# Issue Classification And Umbrella Orchestration

PatchRelay classifies delegated issues into two issue classes:

- `implementation`
- `orchestration`

Issue class is separate from run type. A normal implementation issue can still run `implementation`, `review_fix`, `ci_repair`, and `queue_repair` loops. Orchestration issues use the implementation run type today, but their prompt, plan, and wake context are orchestration-shaped.

## Why This Exists

Not every delegated issue should own a code branch.

Implementation issues own a concrete work slice. They usually produce a PR or a trusted no-PR completion.

Orchestration issues own convergence across related work. They usually represent a parent, umbrella, tracker, rollout, or final audit issue where child issues own most of the concrete implementation.

The point of the split is to prevent umbrella issues from opening overlapping PRs by default while still letting PatchRelay inspect child progress, create justified follow-ups, and close the parent when the goal is satisfied.

## Classification Rules

Default to `implementation`.

Classify as `orchestration` only with evidence that the issue owns related work rather than one direct code slice:

1. explicit issue class metadata
2. Linear parent/sub-issue relationships
3. repo or project guidance that marks a template or label as orchestration-oriented
4. lightweight heuristic fallback when an issue has active child work and reads like an umbrella or tracker

Child issues should normally be `implementation`, even when their parent is orchestration.

## Implementation Behavior

Implementation sessions should:

- solve the delegated issue directly
- use the issue worktree as the action boundary
- publish a PR when code changes need review
- route requested changes, CI failures, and queue evictions into the existing repair loops
- use the no-PR completion check when the run finishes without a linked PR

Related child or parent context can be advisory, but it should not turn a concrete implementation issue into a broad planning run.

## Orchestration Behavior

Orchestration sessions should:

- inspect the parent goal and current child set
- understand why this wake happened
- avoid opening an overlapping umbrella PR by default
- wait when child work is still in motion
- audit delivered child work against the parent goal
- create blocking follow-up work only when needed for the original parent goal
- prefer non-blocking follow-up issues for optional polish
- close the umbrella when the parent goal is satisfied

Small direct cleanup PRs are allowed only when the parent clearly owns the cleanup and the work does not duplicate a child issue.

## Wake Reasons

Useful orchestration wake reasons:

- `initial_delegate`
- `child_changed`
- `child_delivered`
- `child_regressed`
- `all_children_delivered`
- `human_instruction`
- `direct_reply`

The exact taxonomy can stay small. The important rule is that the prompt explains why the orchestration issue is running now.

## Prompt Context

Implementation prompt context:

- issue details
- branch and worktree state
- PR, review, CI, or queue context when relevant
- workflow file pointer
- blockers and dependents as advisory context

Orchestration prompt context:

- parent issue details
- compact child issue summaries
- current wake reason
- recent relevant human comments
- prior orchestration summary when available

Child summaries should stay compact:

- child key and title
- current state
- delegate or assignee when relevant
- PR presence and PR state when relevant
- latest compact delivery summary
- regression marker when a previously delivered child becomes unready again

Do not forward raw child transcripts into the parent prompt.

## Linear Representation

Implementation plans can keep the normal implementation/review/repair lifecycle.

Orchestration plans should use a reusable four-step shape:

1. Review umbrella goal and child set
2. Wait for or inspect child progress
3. Audit delivered outcome
4. Close umbrella or create follow-up work

Good orchestration activity text is short and situational:

- `Reviewing child deliveries`
- `Updating rollout plan`
- `Final audit found one missing blocking slice`
- `Recorded non-blocking cleanup follow-up`

Do not imply that an orchestration session is PR-bound unless it actually created or owns a cleanup PR.

## Convergence Guards

Orchestration should not become endless scope expansion.

Small mechanical guardrails:

- record when orchestration creates follow-up work
- mark follow-ups as blocking or non-blocking
- allow one automatic blocking follow-up wave
- require human confirmation before repeated blocking expansion

These rules are intentionally narrow. The goal is to let orchestration close real gaps without turning every umbrella into a permanent planning loop.

## Current Implementation Anchors

Relevant code lives in:

- `src/issue-class.ts`
- `src/db-types.ts`
- `src/run-orchestrator.ts`
- `src/agent-session-plan.ts`
- `src/no-pr-completion-check.ts`
- `src/orchestration-parent-wake.ts`
- `src/prompting/patchrelay.ts`
- `src/db/issue-session-store.ts`

When extending this area, keep the model small: issue class chooses the session shape; run type still describes the concrete execution or repair loop.
