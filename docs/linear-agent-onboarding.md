# Linear Agent Onboarding

## Goal

This is the shortest current runbook for onboarding one PatchRelay service on one machine, with one or many repositories, against Linear's current agent/app workflow.

Use this guide together with:

- [README.md](../README.md)
- [self-hosting.md](./self-hosting.md)

## Mental Model

PatchRelay is machine-level infrastructure, not a per-repo integration.

- one PatchRelay service runs on the machine
- one Linear OAuth app is usually enough for that PatchRelay instance
- one machine-level `.env` holds the Linear secrets for the service
- one `patchrelay.yaml` contains one `projects[]` block per repository
- each repository contributes workflow policy files such as `IMPLEMENTATION_WORKFLOW.md`

That means repositories own workflow instructions, but PatchRelay owns the Linear app connection, webhook intake, token storage, and worktree orchestration.

## Linear App Setup

Create one Linear OAuth app for this PatchRelay instance in Linear `Settings > API > Applications`.

Recommended settings:

- `actor=app`
- scopes: `read`, `write`, `app:assignable`, `app:mentionable`
- redirect URI: `https://your-domain.example/oauth/linear/callback`
- webhook URL: `https://your-domain.example/webhooks/linear`

Required webhook categories for PatchRelay's core loop:

- issue events
- comment events
- agent session events

Useful supplemental categories:

- permission changes
- OAuth app revoked
- app-user notifications

Why this matters:

- in Linear's current app-user model, delegating work to an agent is not ordinary assignee automation
- a human stays responsible for the issue, and Linear delegates the issue to the app user
- the native trigger PatchRelay cares about is the agent session webhook, not polling

## What Happens When You Delegate

This is the current happy path:

1. A human delegates a Linear issue to the PatchRelay app.
2. Linear creates an agent session for that app user.
3. Linear sends `AgentSessionEvent.created` to PatchRelay's webhook URL.
4. PatchRelay verifies the HMAC signature with `LINEAR_WEBHOOK_SECRET`.
5. PatchRelay resolves the matching `projects[]` entry from the issue key prefix and/or Linear team id.
6. PatchRelay picks the stage from the issue's current Linear state such as `Start`, `Review`, or `Deploy`.
7. PatchRelay creates or reuses the issue worktree and launches the Codex stage.
8. PatchRelay reports progress back to Linear with agent activities and status comments.

Follow-up instructions can then arrive in two ways:

- `AgentSessionEvent.prompted`: the native Linear agent-prompt path; PatchRelay routes this into the active Codex run
- issue comments: PatchRelay also forwards regular issue comments into the active run while the stage is live

Normal operation is webhook-driven. PatchRelay does not poll Linear for delegation.

## Secrets And Boundaries

Keep these secrets at the machine level in `~/.config/patchrelay/.env`:

- `LINEAR_WEBHOOK_SECRET`
- `LINEAR_OAUTH_CLIENT_ID`
- `LINEAR_OAUTH_CLIENT_SECRET`
- `PATCHRELAY_TOKEN_ENCRYPTION_KEY`
- optional: `PATCHRELAY_OPERATOR_TOKEN`

Recommended boundary:

- do not copy these into repository `.env` files
- do not commit them into any repository
- do not duplicate them per repo unless you intentionally run separate PatchRelay instances

How PatchRelay uses them:

- `LINEAR_WEBHOOK_SECRET` verifies incoming webhook signatures
- the OAuth client id/secret complete `patchrelay connect`
- `PATCHRELAY_TOKEN_ENCRYPTION_KEY` encrypts installed workspace access tokens before they are stored in PatchRelay's SQLite database

Practical rule:

- if multiple repos live on one machine and should be driven by the same PatchRelay service, they should usually share one machine-level PatchRelay `.env`

## Multi-Repo Setup

For one machine with several repositories:

1. Run `patchrelay init https://your-domain.example` once.
2. Put the machine-level secrets in `~/.config/patchrelay/.env`.
3. Run `patchrelay project apply <id> <repo-path>` once per repository.
4. Give each project its `repo_path`.
5. Route each project by `issue_key_prefixes`, `linear_team_ids`, or both when you need disambiguation.
6. Keep workflow files inside each repository.
7. If `project apply` reports missing workflow files or secrets, fix them and rerun `patchrelay project apply`.

One PatchRelay instance can serve several repos cleanly as long as routing is unambiguous.

For the standard Linear app-agent flow, you can usually omit `trigger_events` entirely. PatchRelay defaults to `agentSessionCreated`, `agentPrompted`, and `statusChanged`.

## Recommended Onboarding Flow

1. Install PatchRelay and run `patchrelay init https://your-domain.example`.
2. Keep the generated `LINEAR_WEBHOOK_SECRET` and `PATCHRELAY_TOKEN_ENCRYPTION_KEY`, then fill in `LINEAR_OAUTH_CLIENT_ID` and `LINEAR_OAUTH_CLIENT_SECRET` in `~/.config/patchrelay/.env`.
3. Create the Linear OAuth app with `actor=app`, the required scopes, and webhook settings.
4. Add one or more projects with `patchrelay project apply <id> <repo-path>`.
5. If `project apply` reports missing workflow files, add the repo-local workflow files to each automated repository and rerun `patchrelay project apply`.
6. Run `patchrelay doctor` and fix any remaining failures or warnings.
7. Delegate a Linear issue to the PatchRelay app and confirm the webhook-driven stage starts.

Why this order:

- `patchrelay init` is machine-level and requires the public HTTPS origin up front.
- `patchrelay.yaml` should stay minimal; defaults cover the rest of the local runtime in the normal case.
- `patchrelay init` installs the service and a config watcher immediately.
- `patchrelay project apply` is the idempotent happy-path command: it upserts the project, reloads PatchRelay when possible, and reuses or starts the Linear connect flow automatically.

## Operator Notes

- PatchRelay now accepts supplemental Linear app webhooks such as permission-change, app-user-notification, and app-revoked events. They are informational today; the core execution path still depends on issue, comment, and agent-session events.
- If delegation stops working, check team access on the Linear app, the webhook secret, and whether a custom `trigger_events` override accidentally removed `agentSessionCreated` or `agentPrompted`.
