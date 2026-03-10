# PatchRelay

PatchRelay is a self-hosted service and CLI that turns selected Linear issues into controlled Codex sessions on your own machine or server.

It sits between Linear, your local repositories, and `codex app-server`:

- verifies signed Linear webhooks
- routes issues to the right local repository
- creates one durable git branch and worktree per issue
- runs staged agent workflows for implementation, review, deploy, and cleanup
- stores orchestration state in SQLite so you can inspect what happened later
- gives you a terminal-first operator workflow through the `patchrelay` CLI

If you want Linear to be the trigger, Codex to work in real repos with real tools, and a human to be able to inspect or take over cleanly, PatchRelay is built for that model.

## What You Install

The npm package gives you:

- `patchrelay` CLI
- the local PatchRelay service
- config templates for a user-owned install
- a systemd user unit template for Linux

The CLI is the main operator interface. The browser is only used for Linear OAuth consent during `patchrelay connect`.

## Best Fit

PatchRelay is a good fit if:

- you already use Linear as the source of truth for work
- you want automation to run on infrastructure you control
- the agent needs your existing git, SSH, shell, and repo permissions
- you want one branch and worktree per issue lifecycle
- you want to inspect stage history after the live run is over

## Requirements

- Linux is the intended runtime
- Node.js `24+`
- `git`
- `codex` CLI installed and authenticated for the same Unix user that will run PatchRelay
- a Linear workspace
- a Linear OAuth app
- a Linear webhook signing secret

`patchrelay install-service` installs a systemd user service, so Linux with user-level systemd is the happy path. You can still run `patchrelay serve` manually if you want a foreground process.

## How It Works

1. You configure one or more local projects in `patchrelay.yaml`.
2. You link PatchRelay to Linear with `patchrelay connect` and `patchrelay link-installation`.
3. A Linear webhook arrives for a matching issue.
4. PatchRelay maps the issue state to a stage such as `development`, `review`, or `deploy`.
5. PatchRelay creates or reuses that issue's branch and worktree.
6. PatchRelay starts or forks a Codex thread through `codex app-server`.
7. You inspect progress with the CLI, or jump into the exact worktree with `patchrelay open`.

PatchRelay owns the deterministic plumbing: webhook verification, stage claiming, active-state bookkeeping, service comments, and worktree lifecycle.

The agent still owns judgment-heavy decisions such as moving an issue to `Review`, `Deploy`, `Done`, or `Human Needed`.

## Install

Install from npm:

```bash
npm install -g patchrelay
```

Or from a local checkout:

```bash
npm install
npm pack
npm install -g ./patchrelay-*.tgz
```

## Quick Start

### 1. Bootstrap PatchRelay's home directory

```bash
patchrelay init
```

This creates:

- `~/.config/patchrelay/.env`
- `~/.config/patchrelay/patchrelay.yaml`
- `~/.local/state/patchrelay/`
- `~/.local/share/patchrelay/`

Default locations:

- config: `~/.config/patchrelay/`
- database: `~/.local/state/patchrelay/patchrelay.sqlite`
- logs: `~/.local/state/patchrelay/patchrelay.log`
- worktrees: usually `~/.local/share/patchrelay/worktrees/<project>`

### 2. Configure secrets in `.env`

Edit `~/.config/patchrelay/.env`:

```bash
LINEAR_WEBHOOK_SECRET=replace-with-linear-webhook-secret
PATCHRELAY_TOKEN_ENCRYPTION_KEY=replace-with-long-random-secret
LINEAR_OAUTH_CLIENT_ID=replace-with-linear-oauth-client-id
LINEAR_OAUTH_CLIENT_SECRET=replace-with-linear-oauth-client-secret
```

Optional:

```bash
# Only needed if you enable operator_api.enabled: true
PATCHRELAY_OPERATOR_TOKEN=replace-with-random-operator-token
```

### 3. Configure your first project

Edit `~/.config/patchrelay/patchrelay.yaml` and add a project that points at a real local repository:

```yaml
server:
  bind: 127.0.0.1
  port: 8787

linear:
  oauth:
    redirect_uri: http://127.0.0.1:8787/oauth/linear/callback

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
    workflow_labels:
      working: llm-working
      awaiting_handoff: llm-awaiting-handoff
    trusted_actors:
      emails:
        - owner@example.com
```

Important project fields:

- `id`: the project id used by the CLI
- `repo_path`: local repository to automate
- `worktree_root`: where PatchRelay will create per-issue worktrees
- `issue_key_prefixes`: issue prefixes this project should claim, such as `APP`
- `linear_team_ids`: team ids or keys that may route here
- `trigger_events`: which Linear webhook events can steer automation
- `branch_prefix`: prefix for generated branches
- `trusted_actors`: optional allowlist of people or domains allowed to trigger runs

Routing rules:

- PatchRelay matches projects by issue key prefix, team, and optional labels.
- If you define multiple projects, make those routes unambiguous.
- `allow_labels` is optional and can be used to require one of a specific set of labels before a project matches.

### 4. Add workflow docs to the repo

By default PatchRelay looks for these files in the repo root:

```text
IMPLEMENTATION_WORKFLOW.md
REVIEW_WORKFLOW.md
DEPLOY_WORKFLOW.md
CLEANUP_WORKFLOW.md
```

These files are the policy PatchRelay passes into the agent. They should explain what the agent is allowed to do, what checks to run, and what a successful handoff looks like.

If your repo uses different filenames or Linear state names, you can override them globally under `defaults` or per project with `workflow_files` and `workflow_statuses`.

Built-in default Linear states:

- `Start` -> development
- `Review` -> review
- `Deploy` -> deploy
- `Cleanup` -> cleanup
- active states: `Implementing`, `Reviewing`, `Deploying`, `Cleaning Up`
- fallback and handoff states: `Human Needed`, `Done`

### 5. Validate the setup

```bash
patchrelay doctor
```

`doctor` checks:

- required secrets
- repo and worktree paths
- workflow files
- database and log locations
- `git` and `codex` executables
- operator API safety for the current bind settings

### 6. Start the service

Recommended:

```bash
patchrelay install-service
```

That writes `~/.config/systemd/user/patchrelay.service`, reloads user units, and enables + starts the service.

Manual foreground mode:

```bash
patchrelay serve
```

After package updates or config changes:

```bash
patchrelay restart-service
```

### 7. Connect Linear and link an installation

```bash
patchrelay connect --project app
patchrelay installations
patchrelay link-installation app 1
patchrelay webhook app
```

What these do:

- `connect`: starts the Linear OAuth flow and opens a browser for consent
- `installations`: lists connected Linear installations
- `link-installation`: links one configured PatchRelay project to one Linear installation
- `webhook`: prints the webhook URL you should configure in Linear for that project

### 8. Expose only the webhook surface

PatchRelay is designed to run locally and sit behind a reverse proxy such as Caddy or nginx.

Publish only:

- `GET /`
- `GET /health`
- `GET /ready`
- `POST /webhooks/linear`

Keep the wider operator API disabled unless you intentionally need it.

## Using PatchRelay Day To Day

Once the service is running, the main workflow is simple:

1. Move a Linear issue into one of the configured trigger states such as `Start`, `Review`, or `Deploy`.
2. PatchRelay claims the stage, creates or reuses the issue worktree, and launches the Codex turn.
3. Use the CLI to inspect progress, reports, and raw events.
4. Open the issue worktree locally if you want to take over or continue manually.

Useful commands:

| Command | What it does |
| --- | --- |
| `patchrelay doctor` | Validate secrets, paths, workflow files, and executables |
| `patchrelay list --active` | List active tracked issues |
| `patchrelay inspect USE-54` | Show a compact summary for one issue |
| `patchrelay live USE-54 --watch` | Tail the current live stage |
| `patchrelay report USE-54` | Show the latest completed stage report |
| `patchrelay events USE-54 --follow` | Stream raw stage events |
| `patchrelay worktree USE-54 --cd` | Print the issue worktree path or a `cd` command |
| `patchrelay open USE-54` | Open an interactive Codex session in the issue worktree |
| `patchrelay retry USE-54 --stage review` | Requeue a stage |
| `patchrelay webhook app` | Print the current webhook URL for a configured project |

`patchrelay open` resumes the latest issue thread when PatchRelay has one; otherwise it opens Codex directly in the worktree.

## Configuring Another Project

To add a new repository later:

1. Add another entry under `projects:` in `patchrelay.yaml`.
2. Give it a unique `id`, `repo_path`, `worktree_root`, and `branch_prefix`.
3. Set routing with `issue_key_prefixes`, `linear_team_ids`, and optional `allow_labels`.
4. Add workflow docs to that repository.
5. Run `patchrelay doctor`.
6. Link the project to a Linear installation with `patchrelay link-installation <projectId> <installationId>`.
7. Re-run `patchrelay webhook <projectId>` if you need to confirm the webhook target.

If every project shares the same workflow filenames or Linear states, set them once under `defaults` instead of repeating them in each project block.

## Security Notes

- Run PatchRelay as your own Unix user if you want Codex to inherit your existing git, SSH, and local tool permissions.
- Keep PatchRelay bound to `127.0.0.1` unless you have a strong reason not to.
- Expose only the webhook routes through your reverse proxy.
- Leave `operator_api.enabled: false` unless you explicitly need the inspection API.
- If you enable the operator API on anything other than loopback, require a bearer token.
- Treat repo-local workflow files as execution policy, because PatchRelay passes them directly into agent turns.
- Use `trusted_actors` if only certain Linear users or domains should be able to trigger automation for a project.

## Docs

- [Self-hosting guide](https://github.com/krasnoperov/patchrelay/blob/main/docs/self-hosting.md)
- [CLI specification](https://github.com/krasnoperov/patchrelay/blob/main/docs/cli-spec.md)
- [Architecture](https://github.com/krasnoperov/patchrelay/blob/main/docs/architecture.md)
- [Codex workflow integration](https://github.com/krasnoperov/patchrelay/blob/main/docs/codex-workflow.md)
- [Implementation workflow requirements](https://github.com/krasnoperov/patchrelay/blob/main/docs/IMPLEMENTATION_WORKFLOW_REQUIREMENTS.md)
- [Review workflow requirements](https://github.com/krasnoperov/patchrelay/blob/main/docs/REVIEW_WORKFLOW_REQUIREMENTS.md)
- [Deploy workflow requirements](https://github.com/krasnoperov/patchrelay/blob/main/docs/DEPLOY_WORKFLOW_REQUIREMENTS.md)
- [Cleanup workflow requirements](https://github.com/krasnoperov/patchrelay/blob/main/docs/CLEANUP_WORKFLOW_REQUIREMENTS.md)
- [Product spec](https://github.com/krasnoperov/patchrelay/blob/main/PRODUCT_SPEC.md)
- [Security policy](https://github.com/krasnoperov/patchrelay/blob/main/SECURITY.md)

## Status

PatchRelay is usable now, but still early and intentionally opinionated.

The current focus is a solid self-hosted workflow for operators who want Linear-driven automation on their own machines and servers, not a generalized SaaS control plane.
