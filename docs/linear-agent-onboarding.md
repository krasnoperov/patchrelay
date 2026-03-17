# Linear App Setup For PatchRelay

## Purpose

This guide covers the Linear side of a PatchRelay deployment: the OAuth app, webhook categories, delegation model, and the most common troubleshooting points.

Use this guide together with:

- [README.md](../README.md)
- [self-hosting.md](./self-hosting.md)

## Mental Model

PatchRelay is a machine-level execution harness, not a per-repo plugin.

- one PatchRelay service runs on the machine
- one Linear OAuth app is usually enough for that PatchRelay instance
- one machine-level `service.env` holds the Linear secrets
- one `patchrelay.json` contains one `projects[]` block per repository
- each repository contributes workflow policy files such as `IMPLEMENTATION_WORKFLOW.md`

Repositories own workflow instructions. PatchRelay owns the Linear app connection, webhook intake, token storage, routing, worktree orchestration, thread continuity, and reporting.

## Create The Linear OAuth App

Create one Linear OAuth app for this PatchRelay instance in Linear `Settings > API > Applications`.

Recommended settings:

- `actor=app`
- scopes: `read`, `write`, `app:assignable`, and `app:mentionable`
- redirect URI: `https://your-domain.example/oauth/linear/callback`
- webhook URL: `https://your-domain.example/webhooks/linear`

PatchRelay expects one app per machine-level service, not one app per repository.

## Webhook Categories

Required webhook categories for PatchRelay's core loop:

- issue events
- agent session events

Useful supplemental categories:

- permission changes
- OAuth app revoked
- app-user notifications

The execution path is still driven by signed webhooks. PatchRelay does not poll Linear for delegation.

## How Delegation Works

This is the normal happy path:

1. A human delegates a Linear issue to the PatchRelay app.
2. Linear creates an agent session for that app user.
3. Linear sends `AgentSessionEvent.created` to PatchRelay's webhook URL.
4. PatchRelay verifies the HMAC signature with `LINEAR_WEBHOOK_SECRET`.
5. PatchRelay resolves the matching `projects[]` entry from the issue key prefix and/or Linear team id.
6. PatchRelay maps the issue's current Linear state such as `Start`, `Review`, or `Deploy` into the next internal stage.
7. PatchRelay creates or reuses the issue worktree and launches the stage through `codex app-server`.
8. PatchRelay responds through the native Linear agent session first, attaches a signed PatchRelay status URL, keeps the Linear agent plan fresh, and only falls back to service-owned issue comments when there is no active agent session.

## Mentions Vs Delegation

PatchRelay treats these two Linear agent interactions differently:

- mention PatchRelay to open a conversational agent session
- delegate PatchRelay to let it run the workflow for the issue's current Linear state

That means:

- `AgentSessionEvent.created` can arrive for either a mention or a delegation
- PatchRelay only launches a workflow when the issue is actually delegated to the PatchRelay app user
- mention-only sessions stay conversational and tell the operator what state or delegation step is needed next

## Follow-Up Inputs

Follow-up instructions can arrive in two ways:

- `AgentSessionEvent.prompted`: the native Linear agent-prompt path; PatchRelay routes this into the active Codex run
- issue comments: PatchRelay can also forward regular issue comments into the active run while the stage is live

For the standard Linear app-agent flow, you can usually omit `trigger_events` entirely. PatchRelay defaults to `agentSessionCreated` and `agentPrompted`.

## Native Agent UX

PatchRelay now treats the Linear agent session as the primary operator-facing surface for delegated work:

- `AgentSessionEvent.created` gets a native acknowledgement as early as possible so Linear does not mark the app as unresponsive
- PatchRelay updates the session with a signed external status URL that opens a read-only PatchRelay status page
- PatchRelay updates the Linear agent plan as a workflow moves from preparation to running to handoff or completion
- service-owned issue comments remain available as a fallback for non-agent and compatibility flows, but they are no longer the default happy-path status channel for delegated sessions

## Secrets And Boundaries

Keep these secrets at the machine level in `~/.config/patchrelay/service.env`:

- `LINEAR_WEBHOOK_SECRET`
- `LINEAR_OAUTH_CLIENT_ID`
- `LINEAR_OAUTH_CLIENT_SECRET`
- `PATCHRELAY_TOKEN_ENCRYPTION_KEY`

Do not:

- copy them into repository `.env` files
- commit them into any repository
- duplicate them per repo unless you intentionally run separate PatchRelay instances

How PatchRelay uses them:

- `LINEAR_WEBHOOK_SECRET` verifies incoming webhook signatures
- the OAuth client id and secret complete `patchrelay connect`
- `PATCHRELAY_TOKEN_ENCRYPTION_KEY` encrypts installed workspace access tokens before they are stored in PatchRelay's SQLite database

## Multi-Repo Linear Setup

For one machine with several repositories:

1. Run `patchrelay init https://your-domain.example` once.
2. Put the machine-level secrets in `~/.config/patchrelay/service.env`.
3. Run `patchrelay project apply <id> <repo-path>` once per repository.
4. Route each project by `issue_key_prefixes`, `linear_team_ids`, or both when you need disambiguation.
5. Keep workflow files inside each repository.
6. If `project apply` reports missing workflow files or secrets, fix them and rerun `patchrelay project apply`.

One PatchRelay instance can serve several repos cleanly as long as routing is unambiguous.

## Recommended Onboarding Flow

1. Follow [self-hosting.md](./self-hosting.md) to install PatchRelay and create runtime files.
2. Create the Linear OAuth app with `actor=app`, the required scopes, and webhook settings.
3. Fill in `LINEAR_OAUTH_CLIENT_ID` and `LINEAR_OAUTH_CLIENT_SECRET` in `~/.config/patchrelay/service.env`.
4. Run `patchrelay project apply <id> <repo-path>`.
5. Run `patchrelay doctor`.
6. Delegate a Linear issue to the PatchRelay app and confirm the webhook-driven stage starts.

## Troubleshooting

If delegation stops working, check:

- team access on the Linear app
- the configured webhook URL and redirect URI
- `LINEAR_WEBHOOK_SECRET`
- whether a custom `trigger_events` override accidentally removed `agentSessionCreated` or `agentPrompted`
- whether the routed project has valid workflow files and unambiguous routing keys

PatchRelay also accepts supplemental Linear app webhooks such as permission-change, app-user-notification, and app-revoked events. They are useful for observability, but the core execution path depends on agent-session events plus issue metadata for routing and workflow selection.
