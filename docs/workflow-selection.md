# Workflow Selection

## Purpose

This document defines how PatchRelay chooses:

- whether a delegated Linear session should start a workflow at all
- which workflow shape applies
- which stage should run next

It is intentionally small. The goal is deterministic selection, not a highly dynamic routing
system.

## Design Goals

Workflow selection should be:

- deterministic
- easy to inspect and debug
- repo-configurable where needed
- simple enough that the default case requires very little configuration

## Default Starting Point

The first implementation should assume:

- one default workflow: `implementation -> review -> deploy`
- one delegated session starts the first runnable stage for the issue
- repo-specific workflow overrides are optional, not required

If no repo override matches, PatchRelay should use the default workflow.

## Selection Inputs

PatchRelay may use these inputs when selecting workflow and stage:

- whether the session is delegated or mention-only
- the current Linear issue state
- repo workflow policy
- explicit user direction in the current session, if policy allows it
- issue metadata such as labels or type, if repo policy uses them

PatchRelay should not infer workflow shape from free-form agent reasoning alone.

## Selection Order

Selection should follow this order:

1. Decide whether the session should start workflow execution or stay conversational.
2. Resolve the workflow shape.
3. Resolve the active stage within that workflow.

If any step is ambiguous, PatchRelay should stop and route to `Human Needed` rather than guessing.

## Step 1: Workflow Execution vs Conversational Session

PatchRelay should start workflow execution only when:

- the issue is delegated to PatchRelay
- the issue is in a state that maps to a runnable workflow stage
- repo policy allows automatic stage execution for that combination

PatchRelay should remain conversational when:

- the session is mention-only
- the issue is not delegated
- the issue state does not map to a runnable stage
- the user is asking for clarification or status rather than execution

Conversational mode is still allowed to do useful work. In particular, PatchRelay may:

- inspect local repo files
- read existing branch, PR, or issue context
- search the web when needed
- answer questions, summarize findings, and recommend next steps

Conversational mode should not silently start a workflow stage or mutate workflow state unless repo
policy explicitly allows that or the user clearly asks for an action that should do so.

## Step 2: Workflow Resolution

PatchRelay should resolve workflow shape in this order:

1. explicit repo policy match for the issue
2. repo default workflow
3. PatchRelay built-in default workflow

The first implementation should support simple repo policy matching, such as:

- specific issue type
- specific label
- specific repo default

It does not need a complex rule engine.

## Step 3: Stage Resolution

Once the workflow is selected, PatchRelay should determine the active stage from repo policy and
the current Linear issue state.

For the default workflow, the expected mapping is:

- `Start` -> `implementation`
- `Review` -> `review`
- `Deploy` -> `deploy`

If the issue is delegated but the current state does not map cleanly to a workflow stage, PatchRelay
should not guess. It should stop and surface that the state is not runnable.

## Manual Direction

Repo policy may allow an explicit human request in the active Linear session to clarify what stage
should run next.

Examples:

- "start review"
- "deploy this"
- "hold off and summarize findings only"

However:

- explicit direction should only narrow within repo policy, not override it entirely
- PatchRelay should not let a free-form prompt invent a brand new workflow shape

## Minimal First-Version Requirement

A sufficient first implementation is:

- detect delegated vs conversational sessions
- choose the default workflow unless a repo override explicitly applies
- map `Start` / `Review` / `Deploy` to `implementation` / `review` / `deploy`
- escalate when the mapping is unclear

That is enough to build the first deterministic orchestrator without over-designing workflow
selection.
