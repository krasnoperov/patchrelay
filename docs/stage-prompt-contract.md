# Stage Prompt Contract

## Purpose

This document defines the minimum prompt contract between the PatchRelay harness and a stage agent.

The goal is simple harness communication:

- no large rigid schema
- no heavy formatting rules
- no requirement for the agent to emit machine-perfect JSON

PatchRelay needs a brief handoff, not a ceremony.

This document is for workflow stage execution. Conversational sessions may use a lighter prompt and
do not need to follow the stage completion contract unless they are actually running a workflow
stage.

## Shared Prompt Shape

Every stage prompt should include:

- issue identity and goal
- current workflow and current stage
- the repo workflow file or instructions that govern this stage
- the compact carry-forward summary from the prior stage, if any
- the branch / PR / SHA context that matters for this stage
- the rule that the agent should complete the current stage, not invent a new workflow
- the rule that if the next step is unclear, the agent should say so plainly

## Stage-Specific Prompting

Each stage then adds its own objective.

### Implementation

The prompt should tell the agent to:

- make the required change
- verify it appropriately
- prepare review-ready context if successful
- say clearly if it is blocked

### Review

The prompt should tell the agent to:

- inspect the branch, PR, and verification evidence
- identify fixable issues, approval, or ambiguity
- keep findings concrete and actionable

### Deploy

The prompt should tell the agent to:

- verify deploy preconditions
- perform deploy steps if allowed
- report whether the issue is shipped, needs implementation work, needs review reassessment, or
  needs human input

## Required Completion Signal

At the end of a stage, the agent should provide a brief handoff that covers four things:

1. what happened
2. the key facts or artifacts
3. what the next stage most likely is, or that it is unclear
4. what the next stage or human should pay attention to

This can be plain text. It does not need to be rigid JSON.

## Suggested Minimal Handoff Style

The harness should ask for a short closing section in simple prose, for example:

```text
Stage result:
- Completed implementation and updated the locale switcher.
- Verified with lint and UI test locally.
- Next likely stage: review.
- Review should check the EN / RU label behavior and PR metadata.
```

Or:

```text
Stage result:
- Deploy blocked before release.
- CI is green, but release approval requirements are unclear.
- Next likely stage: unclear.
- Human input is needed on whether this can ship to production.
```

The key requirement is clarity, not formatting purity.

## What the Harness Should Not Require

PatchRelay should not require:

- strict JSON output
- verbose chain-of-thought style reasoning
- a fully typed verdict schema
- long narrative restatements of the whole issue history

If the handoff is short, concrete, and easy for the FSM to interpret, it is good enough.

## Conversational Sessions

When PatchRelay is operating conversationally rather than running a workflow stage, it may still:

- inspect local files
- inspect issue, PR, and branch context
- use web research tools when needed
- answer questions and make recommendations

In conversational mode, the harness should avoid stage-specific completion requirements and should
not silently mutate workflow state just because the agent performed research.

## Minimal First-Version Requirement

The first implementation should ask every stage agent for:

- a short completion summary
- the few facts the next stage needs
- the most likely next stage or a clear "unclear / human needed" signal

That is enough to build the first orchestrator while keeping harness communications simple.
