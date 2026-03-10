# PatchRelay

Build an agentic loop with Codex and Linear on your own machine.

PatchRelay is a self-hosted webhook listener and CLI that:

- basically acts as a webhook listener that creates worktrees and runs Codex, done right
- integrates `codex app-server`, Linear, OAuth, and lifecycle monitoring
- uses your setup: your usual tools, your usual access, and your preferred Codex approval or sandbox mode
- can run automatically, report status back to Linear, and handle comments during active runs
- lets you connect to the Codex session in the issue worktree with the usual `codex` CLI and take control when you want

This is the "do the glue layer properly" version of running coding agents from a tracker.

## Why PatchRelay

- Use your own machine, repos, secrets, SSH, shell tools, and deployment access.
- Keep the agent close to the real environment instead of recreating it in a hosted sandbox.
- Choose your own Codex approval and sandbox settings.
- Let Linear drive the loop automatically through states and comments.
- Drop into the exact issue worktree and resume control manually when needed.

PatchRelay owns the boring but important parts:

- webhook verification
- Linear OAuth and installation linking
- issue-to-repo routing
- worktree and branch lifecycle
- stage bookkeeping and reporting
- comment forwarding into active runs

## What It Runs

PatchRelay is designed for a local, operator-owned setup:

- PatchRelay service runs on your machine or server
- Codex runs through `codex app-server`
- Linear is the control surface
- `patchrelay` CLI is the operator interface
- a reverse proxy exposes only the webhook endpoint

Linux and Node.js `24+` are the intended runtime.

## Quick Start

### 1. Install

```bash
npm install -g patchrelay
```

### 2. Bootstrap config

```bash
patchrelay init
```

This creates:

- `~/.config/patchrelay/.env`
- `~/.config/patchrelay/patchrelay.yaml`

### 3. Configure access

Edit `~/.config/patchrelay/.env`:

```bash
LINEAR_WEBHOOK_SECRET=replace-with-linear-webhook-secret
PATCHRELAY_TOKEN_ENCRYPTION_KEY=replace-with-long-random-secret
LINEAR_OAUTH_CLIENT_ID=replace-with-linear-oauth-client-id
LINEAR_OAUTH_CLIENT_SECRET=replace-with-linear-oauth-client-secret
```

### 4. Configure a project

Edit `~/.config/patchrelay/patchrelay.yaml`:

```yaml
server:
  bind: 127.0.0.1
  port: 8787

runner:
  codex:
    approval_policy: never
    sandbox_mode: danger-full-access

projects:
  - id: app
    repo_path: /home/your-user/src/app
    worktree_root: /home/your-user/.local/share/patchrelay/worktrees/app
    issue_key_prefixes:
      - APP
    linear_team_ids:
      - APP
    trigger_events:
      - statusChanged
      - commentCreated
      - commentUpdated
      - assignmentChanged
    branch_prefix: app
```

Minimum project fields:

- `id`: CLI-facing project id
- `repo_path`: local repo to automate
- `worktree_root`: where issue worktrees are created
- `issue_key_prefixes` / `linear_team_ids`: routing rules
- `trigger_events`: which Linear events can steer runs
- `branch_prefix`: generated branch prefix

### 5. Add workflow docs to the repo

By default PatchRelay looks for:

```text
IMPLEMENTATION_WORKFLOW.md
REVIEW_WORKFLOW.md
DEPLOY_WORKFLOW.md
CLEANUP_WORKFLOW.md
```

These files define how the agent should work in that repo.

### 6. Validate and run

```bash
patchrelay doctor
patchrelay install-service
```

Or run it in the foreground:

```bash
patchrelay serve
```

### 7. Connect Linear

```bash
patchrelay connect --project app
patchrelay installations
patchrelay link-installation app 1
patchrelay webhook app
```

Then point your Linear webhook to the URL printed by `patchrelay webhook app`.

## Daily Loop

1. Move a Linear issue into a configured workflow state like `Start`, `Review`, or `Deploy`.
2. PatchRelay creates or reuses the issue worktree and launches the Codex stage.
3. Watch progress from the terminal.
4. If needed, open the same worktree and take over manually.

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

## Configuration Notes

- Keep PatchRelay bound to `127.0.0.1`.
- Expose only `GET /`, `GET /health`, `GET /ready`, and `POST /webhooks/linear`.
- Use `trusted_actors` if only specific Linear users or domains should be allowed to trigger automation.
- Use `defaults.workflow_files` and `defaults.workflow_statuses` if you want one shared convention across projects.
- Override `runner.codex.approval_policy` and `runner.codex.sandbox_mode` to match how much autonomy you want.

## Docs

Keep the README for the big picture; use the docs for the details:

- [Self-hosting and deployment](https://github.com/krasnoperov/patchrelay/blob/main/docs/self-hosting.md)
- [CLI reference](https://github.com/krasnoperov/patchrelay/blob/main/docs/cli-spec.md)
- [Architecture](https://github.com/krasnoperov/patchrelay/blob/main/docs/architecture.md)
- [Codex integration details](https://github.com/krasnoperov/patchrelay/blob/main/docs/codex-workflow.md)
- [Workflow file requirements](https://github.com/krasnoperov/patchrelay/blob/main/docs/IMPLEMENTATION_WORKFLOW_REQUIREMENTS.md)
- [Security policy](https://github.com/krasnoperov/patchrelay/blob/main/SECURITY.md)

## Status

PatchRelay is usable now, but still early and opinionated. The focus is a solid self-hosted Linear + Codex workflow, not a generalized SaaS control plane.
