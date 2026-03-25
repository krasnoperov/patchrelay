# PatchRelay Product Specification

## Summary

PatchRelay is a self-hosted control plane for a **Linear-native agentic software factory**.

It receives delegated work through Linear Agent Sessions, prepares an isolated git worktree for the issue, runs Codex against that worktree, tracks the GitHub pull request lifecycle, loops through review and CI repair via GitHub webhooks, and handles merge queue failures until the change lands or escalates to a human.

PatchRelay should be understood as the system that manages a **controlled coding loop per issue**:

- gather the right context
- take action inside the issue worktree
- verify through repository checks, GitHub review, and queue outcomes
- repeat, retry, or escalate with explicit state

## Product Positioning

PatchRelay is not just a webhook relay and not just a single-run coding bot.
It is the deterministic system around the model and around the loop:

- Linear is the human-facing control plane
- Codex is the execution engine
- GitHub is the source of truth for code review and CI
- A merge queue provider (via GitHub merge_group events) is the delivery gate
- PatchRelay is the stateful orchestrator that ties them together

## Primary Users

- engineering teams that want delegated software work to start in Linear
- operators who need reliable issue-to-PR automation with auditability
- reviewers who want agent work to show up as normal GitHub pull requests
- product or engineering leads who want the agent to communicate naturally in Linear

## Jobs To Be Done

1. When an issue is delegated to the PatchRelay agent in Linear, the system should acknowledge it quickly and start the right workflow without manual handoff.
2. When the agent is working, humans should see plan, progress, blockers, and requests for input directly in Linear.
3. When code is produced, it should appear as a normal GitHub branch and pull request with normal checks and reviews.
4. When reviews or checks fail, the system should repair and iterate automatically before escalating.
5. When a change is approved, it should enter a merge queue and complete delivery with minimal human intervention.

## Product Goals

PatchRelay must:

1. be **Linear-native** rather than treating Linear as a thin event source
2. be **agent-first** with repository-local guidance and durable plans
3. be **restart-safe** so long-running work survives service restarts
4. be **event-driven** so GitHub webhooks trigger reactive repair loops automatically
5. keep the **human loop clear** by escalating only for meaningful ambiguity, unrecoverable failure, or policy-required approval
6. treat **context, verification, and repair** as first-class workflow concerns rather than as prompt-only concerns

## Non-Goals

PatchRelay does not need to:

- preserve compatibility with the previous staged-run architecture
- support many tenant isolation models in v1
- replace GitHub as the review or CI authority
- provide a rich web UI before the control plane is stable
- solve semantic multi-branch conflict resolution perfectly in v1

## Core User Flows

### 1. Delegated Issue To PR

1. A human delegates an issue to the PatchRelay agent in Linear.
2. PatchRelay receives an `AgentSessionEvent`.
3. PatchRelay emits an acknowledgment activity and publishes a plan.
4. PatchRelay creates or restores the issue worktree.
5. PatchRelay packages the issue context, repository guidance, and workflow-specific instructions for the first loop.
6. PatchRelay runs Codex in that worktree with that context.
7. Codex opens or updates a GitHub PR.

### 2. Review Iteration

1. A reviewer requests changes on the GitHub PR.
2. PatchRelay receives a GitHub webhook and transitions the issue to `changes_requested`.
3. PatchRelay starts a `review_fix` run in the same worktree and branch.
4. Codex addresses the feedback, pushes updates, and the issue returns to review.

### 3. CI Repair

1. A required PR check fails.
2. PatchRelay receives a GitHub webhook and transitions the issue to `repairing_ci`.
3. A `ci_repair` run is started in the same worktree and branch.
4. Codex reads the failure logs, pushes a fix, and waits for checks again.

### 4. Merge Queue Repair

1. The PR is approved and enqueued.
2. The queue provider rebases or batches the PR against the current trunk.
3. If queue validation fails, PatchRelay receives a `merge_group` failure event and starts a `queue_repair` run.
4. The change returns to review if necessary and re-enters the queue.

## Functional Requirements

### Linear-Native Session UX

PatchRelay must:

1. support Linear OAuth installation for an app-backed agent identity
2. verify webhook signatures and timestamp freshness
3. respond to delegated issues and follow-up prompts
4. emit Linear activities using `thought`, `action`, `elicitation`, `response`, and `error`
5. acknowledge new agent sessions quickly with an immediate in-flight signal
6. publish and replace structured session plans that reflect the current lifecycle stage
7. attach external links for the PatchRelay status view and pull requests
8. keep Linear updates high-signal by surfacing progress, blockers, and next state without dumping raw trace detail

### Worktree And Runtime Management

PatchRelay must:

1. create one durable worktree per active issue lifecycle
2. run a repository-defined setup hook for each worktree
3. allow the same worktree to be resumed across iterations
4. support Codex execution through App Server
5. treat the worktree as the default action boundary for the issue loop

### GitHub Integration

PatchRelay must:

1. accept GitHub webhooks for PR, review, check, and merge_group events
2. track PR state (number, URL, review state, check status) on the issue record
3. trigger reactive runs (ci_repair, review_fix, queue_repair) from GitHub events
4. treat GitHub as canonical for review and CI truth

### Repair And Escalation

PatchRelay must:

1. distinguish implementation runs from review-fix runs, CI-repair runs, and queue-repair runs
2. keep retry budgets per failure class (CI repair and queue repair have separate budgets)
3. escalate to a human on exhausted retry budget, ambiguous product decisions, or unrecoverable infrastructure failure
4. preserve all context needed for a human to take over
5. keep verification as an explicit part of the lifecycle rather than assuming code generation is sufficient

### Auditability And Observability

PatchRelay must make it easy to answer:

- which Linear session owns the current work
- which worktree and branch belong to the issue
- which PR maps to the issue
- what the current plan is
- what the last successful and failing runs did
- why a repair loop escalated
- what the agent is doing right now at a glance, with deeper status available through the session link

## Product Principles

- Humans steer, agents execute.
- Repository-local guidance is the source of truth.
- Short entrypoint docs, deeper linked docs.
- Deterministic control plane around nondeterministic model behavior.
- Repair loops are normal behavior, not exceptions.
- Distinct loop types beat one generic rerun.
- Context is a product feature, not just prompt text.

## MVP Scope

### In Scope

- Linear agent installation and webhooks
- session activities and plans
- durable worktrees with setup hooks
- Codex execution
- GitHub webhook intake for PR, review, check, and merge_group events
- reactive CI repair loop
- reactive review fix loop
- reactive queue repair loop
- basic operator and audit surface

### Out Of Scope

- multi-tenant hosting
- sophisticated UI dashboards
- arbitrary parallel agents on the same issue
- autonomous semantic-conflict arbitration across many branches
- Graphite-specific merge queue adapter (queue events come via GitHub merge_group)

## Success Criteria

PatchRelay is successful when:

- a delegated issue can progress to a reviewed PR without manual shell work
- humans can understand current status from Linear and GitHub alone
- routine check failures are fixed automatically
- queue failures trigger controlled repair loops rather than silent dead ends
- the repo remains legible enough for future agents to extend safely
