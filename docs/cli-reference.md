# PatchRelay CLI Reference

## Purpose

`patchrelay` is the operator interface for PatchRelay's self-hosted execution harness.

Use it to:

- bootstrap a local PatchRelay installation
- connect Linear to the local service
- inspect staged runs and issue workspaces
- retry work or hand off to a human in the correct worktree
- manage the local systemd service

The browser is only used for Linear OAuth consent.

## Command Summary

```bash
patchrelay <command> [args] [flags]
```

Available commands:

- `inspect <issueKey>`
- `live <issueKey> [--watch] [--json]`
- `report <issueKey> [--stage <stage>] [--stage-run <id>] [--json]`
- `events <issueKey> [--stage-run <id>] [--method <name>] [--follow] [--json]`
- `worktree <issueKey> [--cd] [--json]`
- `open <issueKey> [--print] [--json]`
- `retry <issueKey> [--stage <stage>] [--reason <text>] [--json]`
- `list [--active] [--failed] [--project <projectId>] [--json]`
- `doctor [--json]`
- `init [--force] [--json]`
- `connect [--project <projectId>] [--no-open] [--timeout <seconds>] [--json]`
- `installations [--json]`
- `install-service [--force] [--write-only] [--json]`
- `restart-service [--json]`
- `serve`

## Setup Commands

### `patchrelay init <public-base-url>`

Bootstrap the local PatchRelay home in XDG-style user directories.

Example:

```bash
patchrelay init https://patchrelay.example.com
```

By default this writes:

- `~/.config/patchrelay/.env`
- `~/.config/patchrelay/patchrelay.yaml`
- `~/.config/systemd/user/patchrelay.service`
- `~/.config/systemd/user/patchrelay-reload.service`
- `~/.config/systemd/user/patchrelay.path`

It also creates:

- `~/.local/state/patchrelay/`
- `~/.local/share/patchrelay/`

Flags:

- `--force`
- `--json`

### `patchrelay doctor`

Run preflight checks for the current config and environment.

Checks include:

- required secrets
- repo, worktree, database, log, and workflow paths
- local `git` and `codex` availability
- operator API bind safety
- `server.public_base_url` sanity

Flags:

- `--json`

### `patchrelay connect [--project <projectId>]`

Start a Linear OAuth installation flow for the current PatchRelay service.

In the normal happy path, `patchrelay project apply` starts this automatically after the project config is ready. Use `connect` when you want to rerun or debug the authorization layer directly.

Flags:

- `--project <projectId>`
- `--no-open`
- `--timeout <seconds>`
- `--json`

### `patchrelay installations`

List connected Linear installations and the projects linked to them.

Flags:

- `--json`

## Project And Service Commands

### `patchrelay project apply <id> <repo-path>`

Create or update a repository entry in the local PatchRelay config.

Example:

```bash
patchrelay project apply app /absolute/path/to/repo
```

Behavior:

- writes or updates a `projects[]` entry in `~/.config/patchrelay/patchrelay.yaml`
- stores the repo path as an absolute path
- accepts optional routing with `--issue-prefix <prefixes>` and `--team-id <ids>`
- runs readiness checks for the updated project
- reloads the PatchRelay service when the local setup is ready
- reuses or starts the Linear OAuth installation flow unless `--no-connect` is passed
- is safe to rerun after fixing missing workflow files, secrets, or routing

Flags:

- `--issue-prefix <prefixes>`
- `--team-id <ids>`
- `--no-connect`
- `--timeout <seconds>`
- `--json`

### `patchrelay install-service`

Install or reinstall the systemd user units for PatchRelay.

Flags:

- `--force`
- `--write-only`
- `--json`

`--write-only` skips the systemd activation steps.

### `patchrelay restart-service`

Reload systemd user units and reload-or-restart `patchrelay.service`.

Flags:

- `--json`

### `patchrelay serve`

Run the PatchRelay service in the foreground.

## Inspection Commands

All inspection commands support human-readable output by default and `--json` for scripting.

### `patchrelay inspect <issueKey>`

Show a compact issue summary.

Typical fields:

- issue key and title
- current Linear state
- lifecycle status
- active stage
- latest completed stage
- workspace path
- branch name
- latest thread id
- latest turn id
- high-level status note

If the issue is active, the output also includes the latest live assistant message and turn status.

### `patchrelay live <issueKey>`

Show the live view of the active stage.

Typical fields:

- stage
- thread id
- turn id
- current turn status
- latest assistant message
- latest timestamp seen

Flags:

- `--watch`
- `--json`

### `patchrelay report <issueKey>`

Show completed stage reports for the issue.

Default output includes:

- status
- summary
- assistant conclusion
- commands run
- changed files
- tool calls
- failure note

Flags:

- `--stage <stage>`
- `--stage-run <id>`
- `--json`

### `patchrelay events <issueKey>`

Show raw stored stage notifications for an issue.

Default behavior:

- uses the active stage run if present
- otherwise uses the latest stage run

Flags:

- `--stage-run <id>`
- `--method <name>`
- `--follow`
- `--json`

### `patchrelay list`

List tracked issues known to PatchRelay.

Flags:

- `--active`
- `--failed`
- `--project <projectId>`
- `--json`

## Worktree And Handoff Commands

### `patchrelay worktree <issueKey>`

Print the workspace details for the issue.

Typical fields:

- worktree path
- branch name
- project id

Flags:

- `--cd`
- `--json`

`--cd` prints only the absolute worktree path so you can use:

```bash
cd "$(patchrelay worktree USE-54 --cd)"
```

### `patchrelay open <issueKey>`

Print or launch the human takeover path for the issue.

Current behavior:

- reuses the PatchRelay-managed worktree
- resumes the latest managed thread when available
- launches Codex with `--dangerously-bypass-approvals-and-sandbox`

Flags:

- `--print`
- `--json`

## Retry Command

### `patchrelay retry <issueKey>`

Requeue the current stage for an issue.

Behavior:

- only allowed when there is no active stage run
- reuses the current Linear-mapped desired stage if possible
- otherwise requires `--stage`

Flags:

- `--stage <development|review|deploy|cleanup>`
- `--reason <text>`
- `--json`

## Recommended Operator Flow

```bash
patchrelay init https://patchrelay.example.com
patchrelay project apply app /absolute/path/to/repo
patchrelay doctor
patchrelay inspect APP-123
```

Use [self-hosting.md](./self-hosting.md) for the full install and runtime guide, and [linear-agent-onboarding.md](./linear-agent-onboarding.md) for the Linear app setup and delegation model.
