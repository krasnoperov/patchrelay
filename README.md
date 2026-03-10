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
- Let Linear drive the loop automatically through delegation, workflow stages, and comments.
- Drop into the exact issue worktree and resume control manually when needed.

PatchRelay owns the boring but important parts:

- webhook verification
- Linear OAuth and workspace installations
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
- a reverse proxy exposes the Linear-facing routes

Linux and Node.js `24+` are the intended runtime.

You will also need:

- `git`
- `codex`
- a Linear OAuth app for this PatchRelay deployment
- a Linear webhook secret
- a public HTTPS entrypoint such as Caddy, nginx, or a tunnel so Linear can reach your PatchRelay webhook

For the agent-style PatchRelay flow, configure the Linear OAuth app with:

- `actor=app`
- scopes `read`, `write`, `app:assignable`, and `app:mentionable`
- webhook settings that include issue, comment, agent session, permission change, and inbox notification events

## Quick Start

### 1. Install

```bash
npm install -g patchrelay
```

### 2. Bootstrap config

```bash
patchrelay init https://patchrelay.example.com
```

This creates:

- `~/.config/patchrelay/.env`
- `~/.config/patchrelay/patchrelay.yaml`

`patchrelay init` also prints the exact webhook URL, OAuth callback URL, and the Linear app options to choose in `Settings > API > Applications`.

### 3. Configure access

Edit `~/.config/patchrelay/.env` and fill in only the Linear OAuth client values. Keep the generated webhook secret and token-encryption key:

```bash
LINEAR_WEBHOOK_SECRET=generated-by-patchrelay-init
PATCHRELAY_TOKEN_ENCRYPTION_KEY=generated-by-patchrelay-init
LINEAR_OAUTH_CLIENT_ID=replace-with-linear-oauth-client-id
LINEAR_OAUTH_CLIENT_SECRET=replace-with-linear-oauth-client-secret
```

### 4. Configure a project

Edit the generated `~/.config/patchrelay/patchrelay.yaml`.

Keep the generated top-level structure and add a project block:

```yaml
server:
  bind: 127.0.0.1
  port: 8787
  public_base_url: https://patchrelay.example.com

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
    branch_prefix: app
```

Minimum project fields:

- `id`: CLI-facing project id
- `repo_path`: local repo to automate
- `worktree_root`: where issue worktrees are created
- `issue_key_prefixes` / `linear_team_ids`: routing rules
- `trigger_events`: optional advanced override for which Linear events can steer runs
- `branch_prefix`: generated branch prefix

For the normal Linear app-agent flow, you can usually omit `trigger_events`. PatchRelay defaults to `agentSessionCreated`, `agentPrompted`, and `statusChanged` for app-mode installs.

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
```

If your Linear OAuth app webhook settings are configured, authorizing the app will auto-provision the workspace webhook during `patchrelay connect`.

If you later add another local repo that should use the same Linear installation, run `patchrelay connect --project <id>` for that repo too. PatchRelay now reuses the single saved installation automatically when there is no ambiguity, so you usually will not need another browser approval.

Important:

- Linear needs a public HTTPS URL to reach your webhook.
- `server.public_base_url` is the public domain PatchRelay uses when it prints webhook URLs.
- PatchRelay itself should usually stay bound to `127.0.0.1` and sit behind Caddy, nginx, or another public ingress layer.
- Publish these routes from your reverse proxy: `GET /`, `GET /health`, `GET /ready`, `GET /oauth/linear/callback`, and `POST /webhooks/linear`.
- PatchRelay reacts best when the Linear OAuth app is configured to deliver issue, comment, agent session, permission change, and inbox notification webhooks to the shared PatchRelay endpoint.
- In self-hosted mode you currently do need your own Linear OAuth app, but one app can be reused across all projects and Linear workspaces linked to the same PatchRelay instance.
- Delegation is webhook-driven: Linear creates an agent session and delivers `AgentSessionEvent.created` when work is delegated to the PatchRelay app, then uses `AgentSessionEvent.prompted` for native follow-up instructions.

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

## Configuration Notes

- Keep PatchRelay bound to `127.0.0.1`.
- Set `server.public_base_url` to the public HTTPS origin that Linear should call.
- Expose only `GET /`, `GET /health`, `GET /ready`, `GET /oauth/linear/callback`, and `POST /webhooks/linear`.
- Use `trusted_actors` if only specific Linear users or domains should be allowed to trigger automation.
- Use `defaults.workflow_files` and `defaults.workflow_statuses` if you want one shared convention across projects.
- Override `runner.codex.approval_policy` and `runner.codex.sandbox_mode` to match how much autonomy you want for service-run stages.

## Docs

Keep the README for the big picture; use the docs for the details:

- [Self-hosting and deployment](https://github.com/krasnoperov/patchrelay/blob/main/docs/self-hosting.md)
- [Linear agent onboarding](https://github.com/krasnoperov/patchrelay/blob/main/docs/linear-agent-onboarding.md)
- [CLI reference](https://github.com/krasnoperov/patchrelay/blob/main/docs/cli-spec.md)
- [Architecture](https://github.com/krasnoperov/patchrelay/blob/main/docs/architecture.md)
- [Codex integration details](https://github.com/krasnoperov/patchrelay/blob/main/docs/codex-workflow.md)
- [Workflow file requirements](https://github.com/krasnoperov/patchrelay/blob/main/docs/IMPLEMENTATION_WORKFLOW_REQUIREMENTS.md)
- [Security policy](https://github.com/krasnoperov/patchrelay/blob/main/SECURITY.md)

## Status

PatchRelay is usable now, but still early and opinionated. The focus is a solid self-hosted Linear + Codex workflow, not a generalized SaaS control plane.
