# PatchRelay Product Specification

## Summary

PatchRelay is a local workflow orchestrator for Linear-driven software delivery.

It receives signed Linear webhooks, resolves the owning repository from the issue key and project policy, prepares an issue-specific git worktree, and drives staged Codex work through `codex app-server`. The service persists issue, workspace, pipeline, stage, thread, and observation state in SQLite so operators can inspect exactly what each agent did, even after the live run has ended.

## Product Goals

PatchRelay must:

1. receive and verify Linear webhooks
2. map issue keys such as `USE-25` to the correct local repository and workflow policy
3. create one durable workspace per issue lifecycle
4. support sequential agent stages in the same worktree and branch
5. persist Codex thread ids so later stages can fork or resume prior work
6. capture enough thread history and event data to produce read-only stage reports
7. keep tracker state, local workspace state, and agent history correlated

## Core Workflow

For a matched issue:

1. PatchRelay stores the webhook and normalizes issue metadata.
2. PatchRelay resolves the project from the issue key prefix, team, and label policy.
3. PatchRelay translates the current Linear state into a desired internal stage.
4. PatchRelay creates or reuses the issue workspace and branch.
5. PatchRelay creates a new stage run.
6. PatchRelay starts or forks a Codex thread through `codex app-server`.
7. PatchRelay starts a turn seeded with the stage workflow file and issue context.
8. PatchRelay records thread events and persists a report when the turn completes.
9. PatchRelay waits for the next Linear webhook or queued desired stage.

## Stage Model

PatchRelay supports these ordered stages:

- `development`
- `review`
- `deploy`
- `cleanup`

The same issue may move through several sequential stages while staying on the same worktree and branch.

## Required Behavior

PatchRelay must:

1. verify webhook signatures and timestamp freshness
2. deduplicate deliveries by Linear delivery id
3. persist raw webhook payloads
4. keep one active stage run per issue at a time
5. queue later desired stages while an earlier stage run is active
6. preserve the full Codex thread id for every stage run
7. store per-stage reports that summarize messages, commands, file changes, and tool activity
8. expose read-only HTTP endpoints for issue overview and reports

## Observability Requirements

PatchRelay must make it possible to answer:

- which worktree and branch belong to a given issue
- which stage is currently running
- which Codex thread id owns that stage
- what the agent said
- which commands it ran
- which files it changed
- whether the stage completed, failed, or paused

Read-only observation is a first-class requirement, not an implementation detail.

## Deployment Model

- PatchRelay runs locally on a developer or operator machine
- Caddy or another reverse proxy terminates TLS and forwards Linear webhooks
- PatchRelay stores state in local SQLite
- repositories and worktrees live on local disk
- a long-lived `codex app-server` process is managed by PatchRelay

## Non-Goals

PatchRelay does not need to:

- preserve compatibility with the previous `zmx` architecture
- support multi-user auth or tenant isolation
- implement a rich operator UI before the service model is stable
- perform full Linear sync beyond webhook-driven orchestration

## Public HTTP Surface

PatchRelay exposes:

- `POST /webhooks/linear`
- `GET /health`
- `GET /api/issues/:issueKey`
- `GET /api/issues/:issueKey/report`
- `GET /api/issues/:issueKey/live`
- `GET /api/issues/:issueKey/stages/:stageRunId/events`

## Linear Ownership

PatchRelay owns the deterministic workflow bookkeeping in Linear:

- moving a claimed stage into the matching active state such as `Implementing`, `Reviewing`, or `Deploying`
- maintaining one service-owned status comment per tracked issue
- optionally adding and removing service-owned workflow labels such as `llm-working` and `llm-awaiting-handoff`
- rolling the issue back to a configured fallback state such as `Human Needed` if stage launch fails

Codex remains responsible for judgment-heavy final transitions such as moving an issue to `Review`, `Deploy`, `Done`, or `Human Needed`.

## Future Extensions

Later versions may add:

- pause, cancel, and retry controls
- manual stage steering beyond Linear comments
- richer approval routing
- UI streaming for live thread observation
