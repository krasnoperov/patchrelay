# PatchRelay

PatchRelay is a self-hosted harness for Linear-driven Codex work on your own machine.

It receives Linear webhooks, routes issues to the right local repository, prepares durable issue worktrees, runs staged Codex sessions through `codex app-server`, and keeps the whole run observable and resumable from the CLI.

PatchRelay is the system around the model:

- webhook intake and verification
- Linear OAuth and workspace installations
- issue-to-repo routing
- issue worktree and branch lifecycle
- stage orchestration and thread continuity
- comment forwarding into active runs
- read-only inspection and stage reporting

If you want Codex to work inside your real repos with your real tools, secrets, SSH access, and deployment surface, PatchRelay is the harness that makes that loop reliable.

## Why PatchRelay

- Keep the agent in the real environment instead of rebuilding that environment in a hosted sandbox.
- Use your existing machine, repos, secrets, SSH config, shell tools, and deployment access.
- Keep deterministic workflow logic outside the model: routing, staging, worktree ownership, and reporting.
- Choose the Codex approval and sandbox settings that match your risk tolerance.
- Let Linear drive the loop through delegation, workflow stages, and comments.
- Drop into the exact issue worktree and resume control manually when needed.

## What PatchRelay Owns

PatchRelay does the deterministic harness work that you do not want to re-implement around every model run:

- verifies and deduplicates Linear webhooks
- maps issue events to the correct local project and workflow policy
- creates and reuses one durable worktree and branch per issue lifecycle
- starts or forks Codex threads for sequential stages like development, review, deploy, and cleanup
- persists enough state to correlate the Linear issue, local workspace, stage run, and Codex thread
- reports progress back to Linear and forwards follow-up comments into active runs
- exposes CLI and optional read-only inspection surfaces so operators can understand what happened

## Runtime Model

PatchRelay is designed for a local, operator-owned setup:

- PatchRelay service runs on your machine or server
- Codex runs through `codex app-server`
- Linear is the control surface
- `patchrelay` CLI is the operator interface
- a reverse proxy exposes the Linear-facing routes

Linux and Node.js `24+` are the intended runtime.

You will also need:

- `git`
- `codex`
- a Linear OAuth app for this PatchRelay deployment
- a Linear webhook secret
- a public HTTPS entrypoint such as Caddy, nginx, or a tunnel so Linear can reach your PatchRelay webhook

For the exact OAuth app settings and webhook categories, use the Linear onboarding guide.

## How It Works

1. Linear delegates an issue or sends a stage-driving event.
2. PatchRelay verifies the webhook and routes the issue to the right local project.
3. PatchRelay creates or reuses the issue worktree and launches the matching stage through `codex app-server`.
4. PatchRelay persists thread ids, run state, and observations so the work stays inspectable and resumable.
5. Linear comments can steer the active run, and an operator can take over from the exact same worktree when needed.

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

It creates the local config, env file, and user service units:

- `~/.config/patchrelay/.env`
- `~/.config/patchrelay/patchrelay.yaml`
- `~/.config/systemd/user/patchrelay.service`
- `~/.config/systemd/user/patchrelay-reload.service`
- `~/.config/systemd/user/patchrelay.path`

The generated `patchrelay.yaml` is intentionally minimal, and `patchrelay init` prints the webhook URL, OAuth callback URL, and the Linear app values you need next.

### 3. Configure access

Edit `~/.config/patchrelay/.env` and fill in only the Linear OAuth client values. Keep the generated webhook secret and token-encryption key:

```bash
LINEAR_WEBHOOK_SECRET=generated-by-patchrelay-init
PATCHRELAY_TOKEN_ENCRYPTION_KEY=generated-by-patchrelay-init
LINEAR_OAUTH_CLIENT_ID=replace-with-linear-oauth-client-id
LINEAR_OAUTH_CLIENT_SECRET=replace-with-linear-oauth-client-secret
```

### 4. Configure a project

Add repositories after `patchrelay init` with `patchrelay project apply <id> <repo-path>`.

For a single project, that is usually enough. For multiple projects, add routing with `--issue-prefix APP` or `--team-id <linear-team-id>`.

The generated `~/.config/patchrelay/patchrelay.yaml` is machine-level service config only. Project entries should be created with the CLI, not by hand-editing a placeholder template.

`patchrelay project apply` is idempotent:

- it creates or updates the local project entry
- it checks whether PatchRelay is ready
- it reloads the service when it can
- it reuses or starts the Linear connect flow when the local setup is ready
- if workflow files or secrets are still missing, it tells you exactly what to fix and can be rerun safely

### 5. Add workflow docs to the repo

By default PatchRelay looks for:

```text
IMPLEMENTATION_WORKFLOW.md
REVIEW_WORKFLOW.md
DEPLOY_WORKFLOW.md
CLEANUP_WORKFLOW.md
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
- For ingress, OAuth app setup, and webhook details, use the self-hosting and Linear onboarding docs.

## Daily Loop

1. Delegate a Linear issue to the PatchRelay app.
2. PatchRelay reads the current workflow state like `Start`, `Review`, or `Deploy` to choose the stage to run.
3. Linear sends the delegation and agent-session webhooks to PatchRelay, which creates or reuses the issue worktree and launches the Codex stage.
4. Follow up in the issue comments to steer the active run or wake it with fresh input while it remains delegated.
5. Watch progress from the terminal or open the same worktree and take over manually.

Useful commands:

- `patchrelay list --active`
- `patchrelay inspect APP-123`
- `patchrelay live APP-123 --watch`
- `patchrelay report APP-123`
- `patchrelay events APP-123 --follow`
- `patchrelay worktree APP-123 --cd`
- `patchrelay open APP-123`
- `patchrelay retry APP-123 --stage review`

`patchrelay open` is the handoff bridge: it opens Codex in the issue worktree and resumes the existing thread when PatchRelay has one.

Today that takeover path is intentionally YOLO mode: it launches Codex with `--dangerously-bypass-approvals-and-sandbox`.

## Operator View

PatchRelay keeps enough durable state to answer the questions that matter during and after a run:

- which worktree and branch belong to an issue
- which stage is active or queued
- which Codex thread owns the current work
- what the agent said
- which commands it ran
- which files it changed
- whether the stage completed, failed, or needs handoff

## Docs

Use the README for the product overview and quick start. Use the docs for operating details:

- [Self-hosting and deployment](https://github.com/krasnoperov/patchrelay/blob/main/docs/self-hosting.md)
- [Linear agent onboarding](https://github.com/krasnoperov/patchrelay/blob/main/docs/linear-agent-onboarding.md)
- [CLI reference](https://github.com/krasnoperov/patchrelay/blob/main/docs/cli-reference.md)
- [Architecture](https://github.com/krasnoperov/patchrelay/blob/main/docs/architecture.md)
- [Codex integration details](https://github.com/krasnoperov/patchrelay/blob/main/docs/codex-workflow.md)
- [Workflow file requirements](https://github.com/krasnoperov/patchrelay/blob/main/docs/IMPLEMENTATION_WORKFLOW_REQUIREMENTS.md)
- [Security policy](https://github.com/krasnoperov/patchrelay/blob/main/SECURITY.md)

## Status

PatchRelay is usable now, but still early and opinionated. The focus is a strong self-hosted harness for Linear + Codex work, not a generalized SaaS control plane.
