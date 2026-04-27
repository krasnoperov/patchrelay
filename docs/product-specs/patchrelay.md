# PatchRelay Product Brief

PatchRelay is a self-hosted control plane for Linear-native coding agents.

It turns a delegated Linear issue into a controlled issue loop:

```text
context -> action -> verification -> follow-up or completion
```

PatchRelay owns the issue worktree, Codex run lifecycle, Linear session UX, and repair loops. GitHub remains the source of truth for PR review, checks, and merge state. `review-quill` and `merge-steward` are independent GitHub-native services for review and delivery.

## Users

- engineers delegating software work from Linear
- operators supervising local agent execution
- reviewers who want normal GitHub PRs and reviews
- leads who need progress, blockers, and handoff points to stay visible

## Core Jobs

PatchRelay should:

1. acknowledge delegated Linear issues quickly
2. prepare or resume the correct repository worktree
3. launch the right Codex loop with focused context
4. publish code work as normal GitHub branches and PRs
5. react to requested changes, red checks, and queue evictions
6. escalate when retry budgets, ambiguity, or policy require human judgment

## Product Boundaries

PatchRelay owns:

- Linear OAuth, webhook intake, and agent-session updates
- issue-to-repository routing
- durable issue worktrees
- implementation, review-fix, CI-repair, and queue-repair runs
- no-PR completion checks
- operator commands for status, logs, worktree handoff, and retries

PatchRelay does not own:

- PR review publication; that is `review-quill`
- queue admission or landing; that is `merge-steward`
- GitHub review or CI truth
- multi-tenant SaaS isolation
- autonomous semantic arbitration across unrelated branches

## Success Criteria

PatchRelay is doing its job when:

- a delegated issue can progress to a reviewed PR without manual shell work
- humans can understand current status from Linear, GitHub, and local operator commands
- routine review, CI, and queue failures trigger controlled repair loops
- ambiguous or repeated failures escalate with concise evidence
- repository guidance remains discoverable enough for future agents to extend the system safely
