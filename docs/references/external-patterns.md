# External Reference Patterns

This document captures the external patterns informing the PatchRelay redesign.

## OpenAI Harness Engineering

Source:

- https://openai.com/index/harness-engineering/ (February 11, 2026)

Key takeaways:

- keep `AGENTS.md` short and navigational
- treat `docs/` as the system of record
- use progressive disclosure so agents start with a map and fetch deeper context only when needed
- make the application bootable per worktree
- expose enough local signals for the agent to validate its own work
- optimize for agent legibility, not just human convenience
- enforce architecture boundaries mechanically where possible
- encode recurring quality and style rules into tooling instead of relying on prompt lore
- continuously prune drift with doc-gardening and targeted cleanup loops
- expect higher throughput to change which merge and review gates are worth blocking on

What PatchRelay should borrow:

- document layout
- agent legibility as a design goal
- progressive disclosure over monolithic instructions
- validation surfaces that help the agent inspect failures in the current worktree
- preference for strict, inspectable system structure
- recurring cleanup of stale docs and weak patterns as part of normal maintenance

What PatchRelay should adapt carefully:

- OpenAI's minimal blocking merge-gate philosophy does not transfer directly. PatchRelay still treats GitHub review, required checks, and Merge Steward queue outcomes as authoritative external gates.

## Linear Official Reference Implementation

Source:

- https://github.com/linear/linear-agent-demo

What it shows well:

- app-backed OAuth flow
- webhook verification
- minimal Linear-native agent handling
- native session and interaction surface

What PatchRelay should borrow:

- Linear app installation pattern
- webhook verification and agent identity handling
- native session interaction model

What PatchRelay should not inherit directly:

- a thin comment-driven assistant model without durable orchestration

## Community Linear Coding Harness

Source:

- https://github.com/coleam00/Linear-Coding-Agent-Harness

What it shows well:

- long-running autonomous execution loops
- resume and retry behavior
- command and environment safety hooks
- Linear as the work tracker for iterative agent sessions

What PatchRelay should borrow:

- durable autonomous loop pattern
- explicit runtime safety model
- continuation-oriented execution mindset

What PatchRelay should not inherit directly:

- Linear comments as the main handoff mechanism instead of native agent sessions
- a project-initializer pattern as the core product model

## Synthesis For PatchRelay

PatchRelay should combine:

- the **native Linear agent model** from the official demo
- the **durable execution loop** from the community harness
- the **repo-first documentation and architecture discipline** from harness engineering

That combination is the foundation for a true agentic software factory rather than a one-off coding bot.
