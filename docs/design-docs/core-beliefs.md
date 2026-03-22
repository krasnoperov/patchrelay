# PatchRelay Core Beliefs

## Humans steer, agents execute

The product exists to amplify human engineering judgment, not to bypass it.
Humans decide intent, policy, and acceptance thresholds.
Agents handle implementation, repair, and routine iteration.

## Repository-local knowledge is the source of truth

If a future agent cannot discover a decision in this repository, it effectively does not exist.
Important product rules, architecture choices, and workflow contracts must live in versioned files.

## Keep the entrypoint small

`AGENTS.md` should stay short and navigational.
The deeper documents in `docs/` are the authoritative system of record.

## Deterministic scaffolding beats prompt cleverness

Prompt quality matters, but reliability comes from the system around the model:

- explicit state machines
- durable workspaces
- typed provider adapters
- repair loops
- clear escalation rules

## Linear is the human-facing control plane

PatchRelay should feel native in Linear:

- delegated issues
- session plans
- progress activities
- elicitation when blocked

It should not reduce Linear to a generic backlog poller.

## Worktrees are the isolation primitive

Each issue should have a durable worktree that survives multiple runs.
The same worktree should be reused for implementation, review fixes, CI repair, and queue repair whenever possible.

## GitHub is the canonical delivery truth

Humans may discuss work in Linear, but code review and required checks should be derived from GitHub.
PatchRelay should reflect that truth back into Linear rather than inventing a parallel approval system.

## Queue failures are first-class

A change is not finished when the PR is green.
PatchRelay must model merge queue behavior directly and treat queue failures as a normal part of the lifecycle.

## Strict boundaries help agents move faster

The architecture should make it obvious where logic belongs.
When providers, orchestration, and runtime concerns are mixed together, agents lose the map and the codebase decays.

## Historical artifacts are references, not constraints

Earlier PatchRelay designs may contain useful ideas, but they do not define the new system unless reaffirmed in the current docs.
