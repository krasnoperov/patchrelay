# PatchRelay

PatchRelay is a self-hosted harness for running a controlled coding loop per Linear issue on your own machine.

It receives Linear webhooks, routes issues to the right local repository, prepares durable issue worktrees, runs Codex sessions through `codex app-server`, and keeps the whole issue loop observable and resumable from the CLI. GitHub webhooks drive reactive loops for CI repair, review fixes, and merge queue failures.

PatchRelay is the system around the model:

- webhook intake and verification (Linear and GitHub)
- Linear OAuth and workspace installations
- issue-to-repo routing
- issue worktree and branch lifecycle
- context packaging, run orchestration, and thread continuity
- reactive CI repair, review fix, and merge queue repair loops
- native Linear agent input forwarding into active runs
- read-only inspection and run reporting

If you want Codex to work inside your real repos with your real tools, secrets, SSH access, and deployment surface, PatchRelay is the harness that makes that loop reliable.

## Why PatchRelay

- Keep the agent in the real environment instead of rebuilding that environment in a hosted sandbox.
- Use your existing machine, repos, secrets, SSH config, shell tools, and deployment access.
- Keep deterministic workflow logic outside the model: context packaging, routing, run orchestration, worktree ownership, verification, and reporting.
- Choose the Codex approval and sandbox settings that match your risk tolerance.
- Let Linear drive the loop through delegation and native agent sessions.
- Let GitHub drive reactive loops through PR reviews and CI check events.
- Drop into the exact issue worktree and resume control manually when needed.

## What PatchRelay Owns

PatchRelay does the deterministic harness work that you do not want to re-implement around every model run:

- verifies and deduplicates Linear and GitHub webhooks
- maps issue events to the correct local project
- packages the right issue, repo, review, and failure context for each loop
- creates and reuses one durable worktree and branch per issue lifecycle
- starts Codex threads for implementation runs
- triggers reactive runs for CI failures, review feedback, and merge queue failures
- persists enough state to correlate the Linear issue, local workspace, run, and Codex thread
- reports progress back to Linear and forwards follow-up agent input into active runs
- exposes CLI and optional read-only inspection surfaces so operators can understand what happened

## System Layers

PatchRelay works best when read as five layers with clear ownership:

- policy layer: repo workflow files (`IMPLEMENTATION_WORKFLOW.md`, `REVIEW_WORKFLOW.md`)
- coordination layer: issue claiming, run scheduling, retry budgets, and reconciliation
- execution layer: durable worktrees, Codex threads, and queued turn input delivery
- integration layer: Linear webhooks, GitHub webhooks, OAuth, project routing, and state sync
- observability layer: CLI inspection, reports, event trails, and operator endpoints

That separation is intentional. PatchRelay is not the policy itself and it is not the coding agent. It is the harness that keeps context, action, verification, and repair coordinated in a real repository with real operational state.

## Runtime Model

PatchRelay is designed for a local, operator-owned setup:

- PatchRelay service runs on your machine or server (default `127.0.0.1:8787`)
- Codex runs through `codex app-server`
- Linear is the control surface
- `patchrelay` CLI is the operator interface
- a reverse proxy exposes the Linear-facing and GitHub-facing webhook routes

Linux and Node.js `24+` are the intended runtime.

You will also need:

- `git`
- `codex`
- a Linear OAuth app for this PatchRelay deployment
- a Linear webhook secret
- a public HTTPS entrypoint such as Caddy, nginx, or a tunnel so Linear and GitHub can reach your PatchRelay webhooks

## How It Works

1. A human delegates PatchRelay on an issue to start automation.
2. PatchRelay verifies the webhook, routes the issue to the right local project, and packages the issue context for the first loop.
3. Delegated issues create or reuse the issue worktree and launch an implementation run through `codex app-server`.
4. PatchRelay persists thread ids, run state, and observations so the work stays inspectable and resumable.
5. GitHub webhooks drive reactive verification and repair loops: CI repair on check failures, review fix on changes requested, and merge queue repair on queue failures.
6. Native agent prompts and Linear comments can steer the active run. An operator can take over from the exact same worktree when needed.

## Factory State Machine

Each issue progresses through a factory state machine:

```text
delegated → preparing → implementing → pr_open → awaiting_review
  → changes_requested (review fix run) → back to implementing
  → repairing_ci (CI repair run) → back to pr_open
  → awaiting_queue → done (merged)
  → repairing_queue (queue repair run) → back to pr_open
  → escalated or failed (when retry budgets are exhausted)
```

Run types:

- `implementation` — initial coding work
- `review_fix` — address reviewer feedback
- `ci_repair` — fix failing CI checks
- `queue_repair` — fix merge queue failures

PatchRelay treats these as distinct loop types with different context, entry conditions, and success criteria rather than as one generic "ask the agent again" workflow.

## Restart And Reconciliation

PatchRelay treats restart safety as part of the harness contract, not as a best-effort extra.

After a restart, the service can answer:

- which issue owns each active worktree
- which run was active or queued
- which Codex thread and turn belong to that work
- whether the issue is still eligible to continue
- whether the run should resume, hand off, or fail back to a human state

This is why PatchRelay keeps a durable `issues` and `runs` table alongside Codex thread history and Linear state. The goal is not to duplicate the model transcript. The goal is to make automation restartable, inspectable, and recoverable when the process or machine is interrupted.

## Workflow Files

PatchRelay uses repo-local workflow files as prompts for Codex runs:

- `IMPLEMENTATION_WORKFLOW.md` — used for implementation, CI repair, and queue repair runs
- `REVIEW_WORKFLOW.md` — used for review fix runs

These files define how the agent should work in that repository. Keep them short, action-oriented, and human-authored.

## Access Control

PatchRelay reacts only for issues that route to a configured project.

- use `linear_team_ids`, `issue_key_prefixes`, and optional labels to keep unrelated or public boards out of scope
- in the normal setup, anyone with access to the routed Linear project can delegate work to the PatchRelay app
- use `trusted_actors` only when a project needs a narrower allowlist inside Linear

That keeps the default model simple without forcing an extra allowlist for every team.

## Quick Start

### 1. Install

```bash
npm install -g patchrelay
```

### 2. Bootstrap config

```bash
patchrelay init https://patchrelay.example.com
```

`patchrelay init` requires the public HTTPS origin up front because Linear needs a fixed webhook URL and OAuth callback URL for this PatchRelay instance.

It creates the local config, env file, and system service units:

- `~/.config/patchrelay/runtime.env`
- `~/.config/patchrelay/service.env`
- `~/.config/patchrelay/patchrelay.json`
- `/etc/systemd/system/patchrelay.service`
- `/etc/systemd/system/patchrelay-reload.service`
- `/etc/systemd/system/patchrelay.path`

The generated `patchrelay.json` is intentionally minimal, and `patchrelay init` prints the webhook URL, OAuth callback URL, and the Linear app values you need next.

### 3. Configure access

Edit `~/.config/patchrelay/service.env` and fill in only the Linear OAuth client values. Keep the generated webhook secret and token-encryption key:

```bash
LINEAR_WEBHOOK_SECRET=generated-by-patchrelay-init
PATCHRELAY_TOKEN_ENCRYPTION_KEY=generated-by-patchrelay-init
LINEAR_OAUTH_CLIENT_ID=replace-with-linear-oauth-client-id
LINEAR_OAUTH_CLIENT_SECRET=replace-with-linear-oauth-client-secret
```

Keep service secrets in `service.env`. `runtime.env` is for non-secret overrides such as `PATCHRELAY_DB_PATH` or `PATCHRELAY_LOG_FILE`. Everyday local inspection commands do not require exporting these values in your shell.

### 4. Configure a project

Add repositories after `patchrelay init` with `patchrelay project apply <id> <repo-path>`.

For a single project, that is usually enough. For multiple projects, add routing with `--issue-prefix APP` or `--team-id <linear-team-id>`.

The generated `~/.config/patchrelay/patchrelay.json` is machine-level service config only. Project entries should be created with the CLI, not by hand-editing a placeholder template.

`patchrelay project apply` is idempotent:

- it creates or updates the local project entry
- it checks whether PatchRelay is ready
- it reloads the service when it can
- it reuses or starts the Linear connect flow when the local setup is ready
- if workflow files or secrets are still missing, it tells you exactly what to fix and can be rerun safely

### 5. Add workflow docs to the repo

PatchRelay looks for:

```text
IMPLEMENTATION_WORKFLOW.md
REVIEW_WORKFLOW.md
```

These files define how the agent should work in that repo.

### 6. Validate

```bash
patchrelay doctor
```

### 7. Check the installation

```bash
patchrelay installations
```

In the normal happy path, the earlier `patchrelay project apply <id> <repo-path>` command already handles the connect step for you. `patchrelay connect --project <id>` still exists as the advanced/manual command when you want to retry or debug only the Linear authorization layer.

If you later add another local repo that should use the same Linear installation, run `patchrelay project apply <id> <repo-path>` for that repo too. PatchRelay now reuses the single saved installation automatically when there is no ambiguity, so you usually will not need another browser approval.

Important:

- Linear needs a public HTTPS URL to reach your webhook.
- `patchrelay init <public-base-url>` writes `server.public_base_url`, which PatchRelay uses when it prints webhook URLs.
- For ingress, OAuth app setup, and webhook details, use the self-hosting docs.

## Daily Loop

1. Delegate a Linear issue to the PatchRelay app.
2. Linear sends the delegation and agent-session webhooks to PatchRelay, which creates or reuses the issue worktree and launches an implementation run.
3. Follow up in the Linear agent session to steer the active run or wake it with fresh input while it remains delegated.
4. GitHub webhooks automatically trigger CI repair, review fix, or merge queue repair runs when needed.
5. Watch progress from the terminal or open the same worktree and take over manually.

Useful commands:

- `patchrelay list --active`
- `patchrelay inspect APP-123`
- `patchrelay live APP-123 --watch`
- `patchrelay report APP-123`
- `patchrelay events APP-123 --follow`
- `patchrelay worktree APP-123 --cd`
- `patchrelay open APP-123`
- `patchrelay retry APP-123`

`patchrelay open` is the handoff bridge: it opens Codex in the issue worktree and resumes the existing thread when PatchRelay has one.

Today that takeover path is intentionally YOLO mode: it launches Codex with `--dangerously-bypass-approvals-and-sandbox`.

## Operator View

PatchRelay keeps enough durable state to answer the questions that matter during and after a run:

- which worktree and branch belong to an issue
- which run is active or queued
- which Codex thread owns the current work
- what the agent said
- which commands it ran
- which files it changed
- whether the run completed, failed, or needs handoff

## Docs

Use the README for the product overview and quick start. Use the docs for operating details:

- [Self-hosting and deployment](./docs/self-hosting.md)
- [Architecture](./docs/architecture.md)
- [Design principles](./docs/design-docs/core-beliefs.md)
- [External reference patterns](./docs/references/external-patterns.md)
- [Security policy](./SECURITY.md)

## Status

PatchRelay is usable now, but still early and opinionated. The focus is a strong self-hosted harness for Linear + Codex work, not a generalized SaaS control plane.
