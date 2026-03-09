# PatchRelay Architecture

## System Shape

PatchRelay is a local orchestration service with five responsibilities:

1. accept and verify Linear webhooks
2. persist issue, workspace, pipeline, stage, and observation state in SQLite
3. create and maintain per-issue git worktrees
4. drive Codex through `codex app-server`
5. expose read-only issue and stage reports

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

The service records the desired stage even if another stage is still running.

### 4. Workspace Preparation

When no active stage run exists, PatchRelay:

1. computes the worktree path from the issue key
2. computes the branch name from the configured prefix, issue key, and title
3. creates or refreshes the worktree from repository `HEAD`
4. creates or reuses the issue workspace row

### 5. Codex Thread Execution

For the next stage run:

- if this is the first stage for the issue, PatchRelay calls `thread/start`
- if a prior stage exists, PatchRelay calls `thread/fork`
- PatchRelay then calls `turn/start` with the issue context and workflow file contents

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
5. updates the workspace and issue
6. launches any queued next stage

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

The database is not a copy of Codex thread history. It is the orchestration ledger that points to thread history and caches reports.

## Operator Surface

PatchRelay exposes:

- issue overview by issue key
- stage reports by issue key
- log stream for service-level behavior

The operator can inspect what happened without attaching to a live terminal.
