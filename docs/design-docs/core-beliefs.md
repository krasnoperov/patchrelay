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

## Progressive disclosure beats giant manuals

Agents should start from a small map and fetch deeper context deliberately.
When everything is injected up front, the real task gets crowded out and the repo becomes harder to navigate.

## Deterministic scaffolding beats prompt cleverness

Prompt quality matters, but reliability comes from the system around the model:

- explicit state machines
- durable workspaces
- typed provider adapters
- repair loops
- clear escalation rules

## Legibility includes validation surfaces

Agents should be able to see not just instructions, but also the evidence needed to judge whether work succeeded.
Checks, failure reports, review feedback, and queue incidents should be compact, durable, and easy to route back into the next run.

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
Merge Steward owns queue ordering and landing. PatchRelay must treat queue failures as a normal part of the issue lifecycle and react to steward evictions with repair runs.

## Strict boundaries help agents move faster

The architecture should make it obvious where logic belongs.
When providers, orchestration, and runtime concerns are mixed together, agents lose the map and the codebase decays.

## Encode taste and cleanup into the system

If we care about a rule repeatedly, we should prefer to encode it in docs, lints, templates, or recurring cleanup work.
Human taste should compound through the harness instead of being re-explained in every run.

## Historical artifacts are references, not constraints

Earlier PatchRelay designs may contain useful ideas, but they do not define the new system unless reaffirmed in the current docs.
