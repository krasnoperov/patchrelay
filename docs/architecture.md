# PatchRelay Architecture

## System Shape

PatchRelay is a local orchestration service with seven responsibilities:

1. accept and verify Linear webhooks
2. persist issue, workspace, pipeline, stage, and observation state in SQLite
3. create and maintain per-issue git worktrees
4. drive Codex through `codex app-server`
5. write deterministic workflow state back to Linear
6. steer active turns with queued Linear comments
7. expose local management routes and, optionally, issue and stage inspection endpoints

`codex app-server` is the source of truth for agent thread history.
PatchRelay is the source of truth for workflow policy, workspace ownership, and issue-to-thread correlation.

## Main Entities

### Tracked Issue

One record per Linear issue per project.

Stores:

- Linear issue id and key
- latest known Linear state
- desired next stage
- active workspace id
- active pipeline id
- active stage run id
- latest Codex thread id
- service-owned Linear status comment id

### Workspace

One durable git worktree and branch for an issue lifecycle.

Stores:

- branch name
- worktree path
- workspace status
- last completed stage
- last Codex thread id

### Pipeline Run

A logical automation lifecycle for an issue workspace.

Stores:

- workspace id
- active stage
- pipeline status
- start and end timestamps

### Stage Run

One concrete `development`, `review`, `deploy`, or `cleanup` execution.

Stores:

- workflow stage
- workflow file path
- prompt text
- Codex thread id
- parent thread id
- turn id
- stage status
- report payload

### Thread Event

A persisted Codex app-server notification correlated to a stage run.

Stores:

- thread id
- optional turn id
- notification method
- raw event JSON

## Request Flow

### 1. Webhook Intake

PatchRelay:

- reads the raw request body
- verifies the Linear HMAC signature
- validates timestamp freshness
- deduplicates by delivery id
- archives the webhook payload
- persists a webhook receipt row
- enqueues asynchronous processing

### 2. Issue Routing

PatchRelay resolves a local project from:

- issue key prefix such as `USE`
- Linear team metadata
- optional labels
- allowed trigger events

Issue key prefix is the primary routing key.

### 3. Desired Stage Recording

PatchRelay maps Linear states to internal stages:

- `Start` -> `development`
- `Review` -> `review`
- `Deploy` -> `deploy`
- optional configured cleanup state -> `cleanup`

When PatchRelay claims a stage, it also moves the issue into the matching active state:

- `development` -> `Implementing`
- `review` -> `Reviewing`
- `deploy` -> `Deploying`

The service records the desired stage even if another stage is still running.

### 4. Workspace Preparation

When no active stage run exists, PatchRelay:

1. computes the worktree path from the issue key
2. computes the branch name from the configured prefix, issue key, and title
3. reuses the existing issue worktree when present, otherwise creates it from repository `HEAD`
4. creates or reuses the issue workspace row

### 5. Codex Thread Execution

For the next stage run:

- if this is the first stage for the issue, PatchRelay calls `thread/start`
- if a prior stage exists, PatchRelay calls `thread/fork`
- PatchRelay then calls `turn/start` with the issue context and workflow file contents
- while preparing the run, PatchRelay also claims the matching active Linear state and applies configured workflow labels
- after the turn is live, PatchRelay best-effort refreshes its service-owned running status comment and flushes any queued Linear comments

The resulting thread id and turn id are persisted immediately.

### 6. Observation And Completion

PatchRelay listens to `codex app-server` notifications such as:

- `turn/started`
- `turn/completed`
- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- `turn/plan/updated`
- `turn/diff/updated`

On `turn/completed`, PatchRelay:

1. stores the final notification
2. reads the full thread with `thread/read`
3. synthesizes a stage report
4. marks the stage run completed or failed
5. re-reads Linear to see whether the agent advanced the issue to a final handoff state
6. if the issue is still in the active state PatchRelay set, updates the service-owned Linear comment and workflow labels to flag that handoff is still needed
7. if the issue has already moved on, clears any service-owned workflow labels
8. launches any queued next stage

If stage launch fails before a turn is live, PatchRelay marks the stage failed locally, rolls the issue to the configured fallback Linear state such as `Human Needed`, removes service-owned workflow labels, and updates the service-owned comment with the failure. If PatchRelay later finds an unrecoverable active stage during startup reconciliation, it applies the same failure sync back to Linear only when the issue is still in the service-owned active state.

## Why App-Server

This design intentionally avoids terminal multiplexers as the workflow backbone.

We need:

- durable thread ids
- resumable and forkable stage history
- read-only inspection after a run finishes
- stage sequencing independent from terminal session lifetime

`codex app-server` provides those primitives directly.

## Persistence Summary

SQLite stores:

- webhook receipts
- tracked issues
- workspaces
- pipeline runs
- stage runs
- thread events
- queued turn inputs

The database is not a copy of Codex thread history. It is the orchestration ledger that points to thread history and caches reports.

## Operator Surface

PatchRelay always exposes local management routes for:

- Linear OAuth start and callback handling
- installation listing
- project-to-installation linking

When `operator_api.enabled` is on, PatchRelay also exposes:

- issue overview by issue key
- stage reports by issue key
- live active-stage status by issue key
- raw stage event history by issue key and stage run id
- log stream for service-level behavior

The operator can inspect what happened without attaching to a live terminal.
