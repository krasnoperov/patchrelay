# External Reference Patterns

This document captures the external patterns informing the PatchRelay redesign.

## OpenAI Harness Engineering

Source:

- https://openai.com/index/harness-engineering/

Key takeaways:

- keep `AGENTS.md` short and navigational
- treat `docs/` as the system of record
- make the application bootable per worktree
- expose enough local signals for the agent to validate its own work
- enforce architecture boundaries mechanically where possible

What PatchRelay should borrow:

- document layout
- agent legibility as a design goal
- preference for strict, inspectable system structure

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
