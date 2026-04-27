# PatchRelay Agentic Loop Principles

PatchRelay is not just a place where Codex runs. It manages a controlled loop per issue:

```text
context -> action -> verification -> follow-up or completion
```

Reliability comes from how the system packages context, scopes action, verifies outcomes, and decides whether to continue, retry, or escalate.

## Product Frame

PatchRelay should present itself as a Linear-native control plane for issue execution, not as a generic chatbot, prompt wrapper, or PR generator.

Emphasize:

- receiving delegated work through Linear
- preparing the right issue context
- running the right loop in the right worktree
- verifying through GitHub, repository checks, reviews, and merge queue outcomes
- repeating safely until the issue lands, completes without a PR, or escalates

## Context

Context is a first-class system concern.

Store important facts in typed issue, session, and run state rather than hiding them only in prompts:

- Linear issue metadata
- follow-up prompts and comments
- branch and worktree identity
- PR state
- review feedback
- failing checks
- queue incidents
- repository workflow docs

Prefer compact, task-relevant context over ever-growing transcript replay.

## Loop Types

Keep loop types explicit:

- implementation
- review fix
- CI repair
- queue repair
- orchestration

These loops have different entry conditions, prompts, retry budgets, success criteria, and escalation paths. Do not collapse them into "ask the agent again."

## Verification

The loop is not done when code is generated, when a PR opens, or when branch CI passes once.

Verification surfaces include:

- local repository checks
- GitHub CI
- GitHub review state
- review-quill verdicts when configured
- merge-steward speculative validation and queue incidents
- repo-specific browser or end-to-end validation when required

Failure context should preserve enough exact evidence for the next actor to act without reconstructing the whole transcript.

## Workspaces

The worktree is the action boundary, inspection surface, and handoff point.

Default rule:

- one durable worktree per issue lifecycle
- reuse it for implementation, review fixes, CI repair, and queue repair
- expose the worktree path in operator commands

## Human Checkpoints

PatchRelay should involve humans when judgment is actually needed:

- ambiguous product decisions
- security-sensitive changes
- exhausted retry budgets
- repeated semantic integration failures
- repository policy that requires review or approval

Routine mechanical repair should stay inside the loop. Ambiguity should escalate with concise evidence.

## Documentation Implication

Agents should be able to rediscover current rules from the repository:

- keep `AGENTS.md` navigational
- keep workflow docs short and human-authored
- keep architecture and product decisions in `docs/`
- archive or delete stale planning material instead of mixing it with current guidance
