# PatchRelay Agentic Loop Principles

## Purpose

This document captures the design implications of practical agentic coding for PatchRelay.

PatchRelay should not be described or designed as "a place where Codex runs."
It should be described and designed as a system that manages an **agentic loop per issue**:

```text
context -> action -> verification -> follow-up or completion
```

That framing matters because reliability does not come from a single prompt.
It comes from how the system packages context, scopes action, verifies outcomes, and decides whether to continue, retry, or escalate.

## The Product Should Center The Loop, Not The Model

When PatchRelay explains its value, the emphasis should be on:

- receiving work through Linear
- preparing the right issue context
- running the right kind of loop in the right workspace
- verifying progress through GitHub and repository checks
- repeating safely until the issue lands or escalates

Avoid product language that makes PatchRelay sound like:

- a generic chatbot for issues
- a single-run prompt wrapper
- a PR generator that happens to use Linear

Prefer language like:

- "controlled issue execution loop"
- "deterministic harness around the coding agent"
- "context, repair, and verification system"

## Context Is A First-Class System Concern

The practical agentic loop starts with context gathering.
For PatchRelay, this means context should be treated as a product feature and architecture concern, not just prompt assembly.

Relevant context includes:

- Linear issue metadata
- agent session follow-up prompts
- current branch and worktree identity
- pull request state
- review feedback
- failing checks and queue failures
- repository workflow docs and local guidance

Design implications:

- important context should be stored in typed issue and run state, not hidden in transient prompts
- repo-local guidance files should remain short, durable, and human-authored
- reactive runs should receive focused context for the failure they are fixing
- the system should prefer compact, task-relevant context over ever-growing prompt history

## Distinct Loop Types Beat One Generic Run

PatchRelay should keep different loop types explicit:

- implementation
- review fix
- CI repair
- queue repair

These are not cosmetic labels.
They are separate workflows with different:

- entry conditions
- context packages
- prompts and instructions
- retry budgets
- success criteria
- escalation paths

This keeps the system legible and prevents the product from collapsing into "just ask the agent again."

## Verification Is Not A Side Effect

In practical agentic coding, verification is part of the loop itself.
PatchRelay should keep that principle explicit in both architecture and UX.

Verification should include:

- repository-local checks and tests
- GitHub check state
- review outcomes
- merge queue outcomes
- optional repo-specific browser or end-to-end validation

Design implications:

- the loop is not done when code is generated
- the loop is not done when a PR opens
- the loop is not done when CI passes once
- queue validation must remain a first-class phase

PatchRelay should continue to treat review, CI, and queue behavior as authoritative external verification surfaces.

## Workspaces Should Bound Agent Action

A practical agent loop works best when the agent acts inside a clear workspace boundary.
PatchRelay's worktree model should remain central to the architecture and product story.

The worktree is:

- the action boundary
- the inspection surface for operators
- the persistent location for iterative repair
- the handoff point for humans

Design implications:

- one durable worktree per issue lifecycle remains the default
- implementation, review-fix, CI-repair, and queue-repair runs should reuse the same worktree whenever possible
- operator tooling should always be able to answer which worktree belongs to which issue

## Human-Written Guidance Should Stay In Charge

Practical agentic coding works better when humans curate the guidance and the agent follows it.
PatchRelay should continue to optimize for human-authored repository guidance rather than agent-generated policy files.

That means:

- `AGENTS.md` stays navigational
- workflow docs stay versioned and human-maintained
- architecture and product decisions stay discoverable in `docs/`
- service code should consume those files, not replace them with ad hoc hidden conventions

This is especially important for future agent maintainability.
If an agent cannot rediscover the rules from the repository, the system becomes brittle.

## Summaries And State Matter More Than Raw Transcript Growth

Long-running loops accumulate too much raw context.
PatchRelay should therefore optimize for:

- compact state
- explicit lifecycle markers
- run reports
- summarized outcomes
- targeted re-entry context for the next loop

Design implications:

- database records and state transitions should remain the canonical operational memory
- operator reports should summarize what changed, what ran, and why the loop advanced or failed
- live observability should reconstruct the current state from events, but the system should not depend on replaying the entire raw transcript forever

## The Operator Experience Should Show Loop State Clearly

If PatchRelay manages the loop, operators should be able to see the loop.

An operator surface should answer:

- what context triggered this run
- what kind of run is currently active
- what the agent is doing right now
- what verification step it is waiting on
- why it retried
- why it escalated
- what a human should do next

This implies that observability should be organized around:

- issue
- run
- thread
- turn
- verification state

Rather than around raw logs alone.

## Human Checkpoints Remain Part Of The Design

PatchRelay should not optimize for removing humans from the system.
It should optimize for involving humans only when their judgment is actually needed.

Good human checkpoints include:

- ambiguous product decisions
- security-sensitive or otherwise critical changes
- exhausted retry budgets
- repeated semantic failures
- repository policy that requires review or approval

This keeps the system aligned with the belief that humans steer and agents execute.

## Practical Product Positioning

When in doubt, PatchRelay should present itself as:

"A Linear-native control plane that runs a controlled coding loop per issue through isolated worktrees, explicit verification, and restart-safe repair workflows."

That wording keeps the focus where it belongs:

- issue lifecycle
- loop management
- verification
- repair
- operator clarity

Not just on the underlying model runtime.
