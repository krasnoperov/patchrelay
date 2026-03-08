# PatchRelay Product Specification

## Summary

PatchRelay v1 is a local status-driven webhook-to-worktree launcher for Linear issues.

It runs on a developer-owned machine, receives signed Linear webhooks, extracts issue metadata from the webhook payload, prepares a dedicated git worktree and branch, launches `zmx`/Codex with the issue metadata plus a workflow description file, and persists local run state in SQLite.

PatchRelay v1 does not read the latest issue from Linear before launch and does not write comments or state updates back to Linear.

## Required Behavior

PatchRelay v1 must:

1. receive Linear webhooks over HTTPS
2. verify webhook authenticity and timestamp freshness
3. persist webhook payloads and deduplicate repeated deliveries
4. extract issue metadata directly from the webhook payload
5. resolve the target local project from webhook metadata
6. decide whether the new Linear status should start implementation, review, or deploy
7. create or refresh the issue worktree and branch
8. launch `zmx` / Codex with issue metadata and the configured workflow file
9. persist local run and session state

## Explicit Non-Goals

PatchRelay v1 does not implement:

- safety review stages
- multi-stage orchestration beyond selecting the correct workflow file from the incoming status
- Linear GraphQL reads before launch
- Linear comments or state synchronization
- OAuth flows
- manual replay endpoints
- admin UI

## Deployment Model

- PatchRelay runs locally and binds to `127.0.0.1`
- Caddy terminates TLS and forwards Linear webhooks to PatchRelay
- PatchRelay stores state in local SQLite
- PatchRelay creates git worktrees locally
- PatchRelay starts local `zmx` sessions that run Codex

## Webhook Contract

PatchRelay exposes:

- `POST /webhooks/linear`
- `GET /healthz`

For each webhook it must:

1. read the raw request body
2. verify `Linear-Signature` using the configured webhook secret
3. reject stale payloads using `webhookTimestamp`
4. store the payload and dedupe by delivery id
5. enqueue asynchronous processing
6. return a fast HTTP response

## Routing Model

PatchRelay routes work using metadata contained in the webhook payload itself.

Project resolution is based on configured selectors such as:

- allowed Linear team ids or team keys
- allowed labels
- allowed trigger events

The expected Linear workflow vocabulary is:

- `Todo`
- `Start`
- `Implementing`
- `Review`
- `Reviewing`
- `Deploy`
- `Deploying`
- `Human Needed`
- `Done`

After project resolution, PatchRelay starts work only for configured status transitions such as:

- `Start` -> implementation workflow
- `Review` -> review workflow
- `Deploy` -> deploy workflow

Queued trigger states are `Start`, `Review`, and `Deploy`.

Active execution states such as `Implementing`, `Reviewing`, and `Deploying` do not launch new work. They indicate that an agent has already claimed that stage.

Non-trigger states such as `Todo`, `Human Needed`, and `Done` are persisted and logged but do not launch work.

If only one project is configured, PatchRelay may route directly to that project.

If no configured project matches the webhook metadata, the event is ignored after persistence.

## Launch Contract

For a matched issue event, PatchRelay must derive:

- issue id
- issue key if present
- issue title if present
- issue URL if present
- branch name
- worktree path
- workflow file path

PatchRelay then:

1. ensures the worktree root exists
2. creates or refreshes the worktree for the issue
3. creates or resets the issue branch from `HEAD`
4. launches a named `zmx` session
5. runs Codex in the worktree with the issue metadata and workflow file path using explicit non-interactive CLI flags configured by PatchRelay

## Persistence Model

PatchRelay persists:

- webhook receipts
- issue records
- launch runs
- active and completed sessions

The SQLite database is the local source of truth for what PatchRelay accepted and launched.

## Local Logging

PatchRelay v1 keeps local operator logs for:

- the main structured processing log, always written to the configured local file
- one archived file per received webhook
- launch planning details
- the git and `zmx` commands it is about to run
- `zmx` stdout, stderr, and exit status

## Future Direction

Later versions may add:

- Linear write-back
- OAuth-based app identity
- richer trigger policies
- native Linear agent UX

Those are explicitly outside the v1 implementation.
