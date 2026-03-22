# PatchRelay Product Specification

## Summary

PatchRelay is a self-hosted control plane for a **Linear-native agentic software factory**.

It receives delegated work through Linear Agent Sessions, prepares an isolated git worktree for the issue, runs Codex against that worktree, creates and updates a GitHub pull request, loops through review and CI repair, and hands approved changes to a merge queue provider such as Graphite until the change lands or escalates to a human.

## Product Positioning

PatchRelay is not just a webhook relay and not just a single-run coding bot.
It is the deterministic system around the model:

- Linear is the human-facing control plane
- Codex is the execution engine
- GitHub is the source of truth for code review and CI
- Graphite or another queue is the delivery gate
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
4. be **provider-oriented** so GitHub, Graphite, and Codex integrations are replaceable at the boundary
5. keep the **human loop clear** by escalating only for meaningful ambiguity, unrecoverable failure, or policy-required approval

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
5. PatchRelay runs Codex in that worktree with repo guidance and issue context.
6. PatchRelay opens or updates a GitHub PR and links it back to Linear.

### 2. Review Iteration

1. A human or automated reviewer leaves comments in GitHub or Graphite, or follows up in Linear.
2. PatchRelay normalizes the feedback into review events.
3. PatchRelay resumes work in the same worktree and branch.
4. PatchRelay pushes updates, resolves comments where appropriate, and posts a summary back to Linear.

### 3. CI Repair

1. A required PR check fails.
2. PatchRelay captures the failing jobs and logs.
3. A specialized repair run is started in the same worktree and branch.
4. PatchRelay pushes a fix and waits for checks again.

### 4. Merge Queue Repair

1. The PR is approved and enqueued.
2. The queue provider rebases or batches the PR against the current trunk.
3. If queue validation fails, PatchRelay starts an integration-repair run.
4. The change returns to review if necessary and re-enters the queue.

## Functional Requirements

### Linear-Native Session UX

PatchRelay must:

1. support Linear OAuth installation for an app-backed agent identity
2. verify webhook signatures and timestamp freshness
3. respond to delegated issues and follow-up prompts
4. emit Linear activities using `thought`, `action`, `elicitation`, `response`, and `error`
5. publish and replace structured session plans
6. attach external links for run dashboards and pull requests

### Worktree And Runtime Management

PatchRelay must:

1. create one durable worktree per active issue lifecycle
2. run a repository-defined setup hook for each worktree
3. allow the same worktree to be resumed across iterations
4. support Codex execution through App Server first, with CLI fallback if needed
5. make per-worktree application runtime and observability bootable where the repo supports it

### GitHub Integration

PatchRelay must:

1. create and update branches and pull requests
2. ingest review states and review comments
3. ingest required check status and failure logs
4. treat GitHub as canonical for review and CI truth

### Merge Queue Integration

PatchRelay must:

1. support a merge queue provider abstraction
2. ship with Graphite as the first supported provider
3. model queue states, blockers, and failure reasons explicitly
4. route queue failures into a separate repair loop
5. avoid leaking provider-specific behavior into generic orchestration logic

### Repair And Escalation

PatchRelay must:

1. distinguish implementation runs from review-fix runs, CI-fix runs, and queue-repair runs
2. keep retry budgets per failure class
3. escalate to a human on exhausted retry budget, ambiguous product decisions, or unrecoverable infrastructure failure
4. preserve all context needed for a human to take over

### Auditability And Observability

PatchRelay must make it easy to answer:

- which Linear session owns the current work
- which worktree and branch belong to the issue
- which PR maps to the issue
- what the current plan is
- what the last successful and failing runs did
- why a repair loop escalated

## Product Principles

- Humans steer, agents execute.
- Repository-local guidance is the source of truth.
- Short entrypoint docs, deeper linked docs.
- Deterministic control plane around nondeterministic model behavior.
- Strict boundaries between orchestration logic and provider adapters.
- Repair loops are normal behavior, not exceptions.

## MVP Scope

### In Scope

- Linear agent installation and webhooks
- session activities and plans
- durable worktrees with setup hooks
- Codex execution
- GitHub PR creation and update
- review ingestion
- CI repair loop
- Graphite merge queue integration
- queue repair loop
- basic operator and audit surface

### Out Of Scope

- multi-tenant hosting
- sophisticated UI dashboards
- arbitrary parallel agents on the same issue
- autonomous semantic-conflict arbitration across many branches
- multiple merge queue providers in the first release

## Success Criteria

PatchRelay is successful when:

- a delegated issue can progress to a reviewed PR without manual shell work
- humans can understand current status from Linear and GitHub alone
- routine check failures are fixed automatically
- queue failures trigger controlled repair loops rather than silent dead ends
- the repo remains legible enough for future agents to extend safely
