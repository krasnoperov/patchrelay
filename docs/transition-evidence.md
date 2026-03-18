# Transition Evidence

## Purpose

This document defines the minimum evidence PatchRelay should use when deciding whether a stage may
advance, loop back, or escalate.

The goal is not to force a large handoff schema. The goal is to make transition decisions
implementable and auditable.

## Principles

Transition decisions should be based on:

- concrete repo and issue facts
- compact stage summaries
- repo workflow policy

PatchRelay should prefer simple evidence rules over additional agent judgment.

## Default Workflow

This document defines evidence for the default workflow:

- `implementation -> review`
- `review -> deploy`
- `review -> implementation`
- `deploy -> implementation`
- `deploy -> review`
- `deploy -> done`
- `* -> human_needed`

Repos may extend or override these rules.

## Implementation -> Review

PatchRelay may advance from `implementation` to `review` when:

- the implementation stage reports completion rather than blockage
- the branch/worktree state exists and is usable for review
- the stage provides a brief summary of what changed
- the stage provides a brief verification summary

Minimum carry-forward:

- what changed
- what was verified
- branch / PR / SHA context if available
- anything review should pay special attention to

## Review -> Deploy

PatchRelay may advance from `review` to `deploy` when:

- the review stage reports approval
- repo policy says deploy is allowed from that approval state
- any repo-required review-owned gates have been satisfied

Minimum carry-forward:

- review approval summary
- relevant verification evidence
- branch / PR / SHA context
- what deploy should watch most carefully

## Review -> Implementation

PatchRelay should route from `review` back to `implementation` when:

- review finds fixable issues that belong to implementation
- the next step is clear enough that implementation can act without human clarification

Minimum carry-forward:

- concrete findings
- why they matter
- where implementation should pick up
- any failing checks or artifacts tied to the findings

## Deploy -> Done

PatchRelay may advance from `deploy` to `done` when:

- deploy completed successfully
- repo policy says the issue may be considered shipped
- the stage provides whatever shipped target or verification evidence repo policy requires

Minimum carry-forward:

- shipped summary
- deployed target / SHA / environment if available
- relevant post-deploy verification result

## Deploy -> Implementation

PatchRelay should route from `deploy` back to `implementation` when:

- deploy found a fixable code or implementation issue
- the failure is best addressed by changing the branch or code

Minimum carry-forward:

- exact deploy failure or verification failure
- failing environment or run context
- why this is an implementation problem
- branch / PR / SHA context

## Deploy -> Review

PatchRelay may route from `deploy` back to `review` when:

- the code itself is likely correct
- the blocking issue is review or readiness related rather than implementation related
- sending the issue back to implementation would add churn without helping

Minimum carry-forward:

- the exact readiness or approval issue
- why implementation is likely not the missing piece
- branch / PR / SHA context
- what review should reassess

## Any Stage -> Human Needed

PatchRelay should route to `human_needed` when:

- the next stage is ambiguous
- repo policy requires a human decision
- retry or timeout limits have been exceeded
- delegation or issue ownership changed in a conflicting way
- the available evidence is too weak to continue safely

Minimum carry-forward:

- what stage was running
- what blocked automatic continuation
- what facts are known
- what a human needs to decide next

## Minimal First-Version Rule

The first implementation should use a small set of evidence checks:

- current stage
- current Linear issue state
- branch / PR / SHA context where relevant
- stage summary
- verification or deploy result
- repo policy gates

That is enough to implement deterministic transitions for the default workflow without inventing a
heavy evidence protocol.
