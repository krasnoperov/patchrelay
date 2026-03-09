# PatchRelay Implementation Plan

## Outcome

Build PatchRelay as a local issue-to-workspace orchestrator on top of `codex app-server`.

The completed service should:

1. route Linear issues to repositories by issue key prefix and project policy
2. keep one durable worktree and branch per issue lifecycle
3. execute sequential stage runs through Codex thread start and fork operations
4. persist enough thread history and event data to generate read-only reports

## Milestone 1: Core Intake

Deliver:

1. verified webhook ingestion
2. webhook archival
3. normalized issue metadata extraction
4. project resolution by issue key prefix, team, and labels

Acceptance:

- duplicate deliveries are ignored
- invalid signatures are rejected
- valid status webhooks create or update tracked issue rows

## Milestone 2: Workspace Ledger

Deliver:

1. new SQLite schema for tracked issues, workspaces, pipeline runs, stage runs, and thread events
2. one active stage run per issue
3. queued desired stage behavior

Acceptance:

- later stage webhooks are queued while a stage is active
- the same issue keeps the same workspace across stages

## Milestone 3: Codex App-Server Client

Deliver:

1. long-lived `codex app-server` process management
2. JSON-RPC client transport
3. support for `initialize`, `thread/start`, `thread/fork`, `thread/resume`, `turn/start`, `thread/read`, and `thread/list`
4. notification persistence

Acceptance:

- PatchRelay can create a thread for the first stage
- PatchRelay can fork from the previous thread for the next stage
- thread ids are persisted in SQLite

## Milestone 4: Stage Execution Engine

Deliver:

1. worktree preparation from repo `HEAD`
2. stage prompt construction from issue metadata and workflow file contents
3. stage completion handling on `turn/completed`
4. pipeline progression to later queued stages

Acceptance:

- `development -> review -> deploy -> cleanup` can run as separate sequential stage runs
- follow-up stages do not depend on terminal session lifetime

## Milestone 5: Read-Only Observation

Deliver:

1. persisted thread event log per stage
2. thread readback after stage completion
3. stage report synthesis covering messages, commands, file changes, and tool activity
4. HTTP report endpoints

Acceptance:

- operator can inspect what happened after a stage has already finished
- report can be retrieved without connecting to a terminal session

## Milestone 6: Hardening

Deliver:

1. restart-safe app-server reconnect strategy
2. explicit failure handling for interrupted stages
3. pause and human-needed policy hooks
4. richer report summaries

Acceptance:

- service restart does not orphan issue state
- failed stage runs remain inspectable
