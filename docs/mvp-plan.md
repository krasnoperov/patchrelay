# PatchRelay v1 Plan

## Goal

Ship a minimal, reliable version of PatchRelay that turns a verified Linear webhook into a local coding session.

## v1 Scope

Included:

1. receive Linear webhooks over HTTPS via Caddy
2. verify signature and timestamp
3. persist webhook payloads and dedupe repeated deliveries
4. extract issue metadata from the webhook payload
5. resolve the target project
6. select implementation, review, or deploy from the new Linear status
7. create a worktree and branch for the issue
8. launch `zmx` / Codex with issue metadata and the configured workflow file
9. persist local run and session state

Linear statuses used by v1:

- `Todo`
- `Start`
- `Implementing`
- `Review`
- `Reviewing`
- `Deploy`
- `Deploying`
- `Human Needed`
- `Done`

Trigger statuses:

- `Start`
- `Review`
- `Deploy`

Non-trigger statuses:

- `Todo`
- `Implementing`
- `Reviewing`
- `Deploying`
- `Human Needed`
- `Done`

Deferred:

- Linear GraphQL reads
- Linear comments
- Linear status updates
- OAuth flows
- safety stage
- admin tooling

## Success Criteria

PatchRelay v1 is successful when it can reliably:

1. receive a real Linear issue webhook
2. verify and persist the delivery
3. route the event to the correct configured project
4. create the expected worktree and branch
5. launch a `zmx` session that runs Codex in that worktree
6. record the resulting local run state in SQLite

## Deployment Shape

- public URL: `https://patchrelay.krasnoperov.me/webhooks/linear`
- Caddy reverse proxies to the local PatchRelay HTTP server
- PatchRelay stores state in SQLite
- PatchRelay launches local `zmx` sessions

## Operator Expectations

For v1, observability comes from:

- structured logs
- SQLite state
- local git worktrees
- `zmx` session inspection
