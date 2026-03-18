# Self-Hosting PatchRelay

## Purpose

This is the canonical install and runtime guide for PatchRelay.

PatchRelay is designed to run on infrastructure you control, close to the repositories and deployment surface that Codex needs to access. In harness terms, self-hosting matters because PatchRelay is the execution system around the model: it routes work, prepares durable workspaces, carries forward state, and keeps runs inspectable in the real environment where the code lives.

For the Linear OAuth app and delegation model, use [linear-agent-onboarding.md](./linear-agent-onboarding.md).
For shipping updates to a live PatchRelay install, use [shipping.md](./shipping.md).

## Deployment Shape

The recommended deployment mode is personal-mode:

1. PatchRelay runs as your real Unix user.
2. Codex inherits that user's existing git, SSH, shell, and repo permissions.
3. The `patchrelay` CLI is the primary operator interface.
4. The browser is used only to approve Linear OAuth consent.
5. PatchRelay itself still listens locally on `127.0.0.1:8787`.

The common production shape is:

1. PatchRelay runs locally and listens on `127.0.0.1:8787`.
2. `patchrelay` CLI drives setup, authorization, and inspection.
3. Caddy or another reverse proxy provides the public HTTPS entrypoint Linear can reach.
4. Only `/`, `/health`, `/ready`, `/oauth/linear/callback`, and `POST /webhooks/linear` are published.
5. PatchRelay reads and writes local git repos and worktrees directly.
6. Codex runs through `codex app-server` on the same machine under the same user.

## Prerequisites

- Linux host with shell access
- Node.js 24 or newer
- `git`
- `codex` CLI installed and authenticated for the same user who will run PatchRelay
- access to the local repositories you want to automate
- Linear workspace access
- one Linear OAuth app for this PatchRelay deployment
- one Linear webhook secret

## Public Ingress

Linear cannot call a service that only exists on loopback, so the normal setup needs both:

- PatchRelay bound locally, usually `127.0.0.1:8787`
- a public HTTPS domain such as `https://patchrelay.example.com` forwarded to that local service by Caddy, nginx, or a tunnel

PatchRelay should know that public origin through `server.public_base_url`.

By default PatchRelay derives the OAuth callback as:

- `${server.public_base_url}/oauth/linear/callback`

The callback path is fixed and must remain `/oauth/linear/callback`.

## 1. Install PatchRelay

```bash
npm install -g patchrelay
```

If you are installing from a local source checkout instead of the package registry:

```bash
npm install
npm pack
npm install -g ./patchrelay-*.tgz
```

## 2. Create Runtime Files

```bash
patchrelay init https://patchrelay.example.com
```

This command requires the public HTTPS origin up front because PatchRelay must know the Linear-facing webhook URL and OAuth callback URL for this machine.

It creates:

- `~/.config/patchrelay/runtime.env`
- `~/.config/patchrelay/service.env`
- `~/.config/patchrelay/patchrelay.json`
- `~/.config/systemd/user/patchrelay.service`
- `~/.config/systemd/user/patchrelay-reload.service`
- `~/.config/systemd/user/patchrelay.path`

Default runtime paths are:

- config: `~/.config/patchrelay/`
- database: `~/.local/state/patchrelay/patchrelay.sqlite`
- logs: `~/.local/state/patchrelay/patchrelay.log`
- worktree roots: usually `~/.local/share/patchrelay/worktrees/<project>`

## Troubleshooting

When something looks stuck or inconsistent, start with the local PatchRelay logs:

- log file: `~/.local/state/patchrelay/patchrelay.log`
- user service logs: `journalctl --user -u patchrelay.service -f`

Use the log file when you want the persisted service history on disk. Use `journalctl` when you want the live user-service stream managed by systemd.

Common places to look:

- Linear did nothing after a delegation or mention:
  check for webhook intake logs such as accepted, rejected, stale, or duplicate deliveries
- the agent ignored a new Linear comment or prompt:
  check for queued turn-input delivery logs and any `Failed to deliver queued Linear ... to active Codex turn` warnings
- Codex execution looks broken or stops unexpectedly:
  check for `Starting Codex app-server`, `Codex app-server request failed`, `Codex app-server stderr`, or `Codex app-server exited`
- Codex finished but Linear comments, labels, or handoff state look wrong:
  check for `Stage completed locally but PatchRelay could not finish the final Linear sync`

The most useful correlation fields in logs are:

- `webhookId`
- `webhookEventId`
- `projectId`
- `issueKey`
- `issueId`
- `stageRunId`
- `threadId`
- `turnId`
- `agentSessionId`

The generated `patchrelay.json` stays intentionally minimal. In the default setup it only needs `server.public_base_url`; PatchRelay already has built-in defaults for the local bind address, database path, logs, worktree roots, workflow filenames, workflow states, and Codex runner settings.

`patchrelay init` also installs the user service and a watcher that reload-or-restarts PatchRelay whenever `patchrelay.json`, `runtime.env`, or `service.env` changes.

## 3. Configure Machine-Level Secrets

Edit `~/.config/patchrelay/service.env` and keep the generated webhook secret and token-encryption key:

```bash
LINEAR_WEBHOOK_SECRET=generated-by-patchrelay-init
PATCHRELAY_TOKEN_ENCRYPTION_KEY=generated-by-patchrelay-init
LINEAR_OAUTH_CLIENT_ID=replace-with-linear-oauth-client-id
LINEAR_OAUTH_CLIENT_SECRET=replace-with-linear-oauth-client-secret
```

Optional non-secret overrides such as `PATCHRELAY_CONFIG`, `PATCHRELAY_DB_PATH`, and `PATCHRELAY_LOG_FILE` belong in `~/.config/patchrelay/runtime.env`. In personal-mode, prefer user-owned paths over `/opt` or `/var` paths.

Keep these values machine-level. They belong in PatchRelay's own env files, not inside repository `.env` files.
PatchRelay reads `runtime.env` for non-secret runtime overrides and `service.env` for service credentials. Read-only local inspection commands use local state and do not require exporting these values in your shell.

For the Linear OAuth app settings and webhook categories, use [linear-agent-onboarding.md](./linear-agent-onboarding.md).

## 4. Configure Projects

`patchrelay init` writes only the machine-level service config to `~/.config/patchrelay/patchrelay.json`.

At the top level, configure the public HTTPS origin that Linear should use:

```json
{
  "server": {
    "public_base_url": "https://patchrelay.example.com"
  }
}
```

Add repositories with `patchrelay project apply <id> <repo-path>`. A project only needs:

- `id`
- `repo_path`
- one routing key when you have multiple projects: `issue_key_prefixes` or `linear_team_ids`

`patchrelay project apply` is the idempotent happy-path command:

- it creates or updates the local project entry
- it checks whether PatchRelay is ready to start with that project
- it reloads the service when it can
- it reuses or starts the Linear authorization flow when the local setup is ready
- if workflow files or secrets are still missing, it tells you what to fix and can be rerun safely

PatchRelay is convention-first here:

- by default it generates four workflow bindings per project: `development`, `review`, `deploy`, and `cleanup`
- each binding maps one Linear state such as `Start` or `Deploy` to one repo workflow file
- by default it looks for `IMPLEMENTATION_WORKFLOW.md`, `REVIEW_WORKFLOW.md`, `DEPLOY_WORKFLOW.md`, and `CLEANUP_WORKFLOW.md` in each repo root
- by default it uses `delegateChanged`, `statusChanged`, `agentSessionCreated`, `agentPrompted`, `commentCreated`, and `commentUpdated` as trigger events for app-mode installs
- edit `projects[].workflows` when you want different state names, active states, workflow ids, or workflow file paths
- `worktree_root` defaults to `~/.local/share/patchrelay/worktrees/<project-id>`
- `branch_prefix` defaults to a slug of the project id

`projects[].trigger_events` is optional and mainly for advanced overrides. Keep the default set unless you have a specific reason to narrow it, because delegation and state changes are part of the automatic pipeline contract.

Workflow file paths are resolved relative to `repo_path` unless you provide an absolute path. PatchRelay chooses a workflow by matching the current Linear state to `projects[].workflows[].when_state`, then moves the issue to that workflow's `active_state` while Codex is running.

If you want Linear itself to be part of your trust boundary, configure `trusted_actors` on each project. That allowlist can name specific owners by `id` or `email`, or define a group-style allowlist with `email_domains`.

## 5. Add Repo-Local Workflow Docs

Each automated repository should contain:

- `IMPLEMENTATION_WORKFLOW.md`
- `REVIEW_WORKFLOW.md`
- `DEPLOY_WORKFLOW.md`
- `CLEANUP_WORKFLOW.md` by default

These files are the repo-local policy PatchRelay passes into each stage run. They should explain what the agent is allowed to do in that repository, what validation is required, and when final issue states should be moved.

Requirement references:

- [IMPLEMENTATION_WORKFLOW_REQUIREMENTS.md](./IMPLEMENTATION_WORKFLOW_REQUIREMENTS.md)
- [REVIEW_WORKFLOW_REQUIREMENTS.md](./REVIEW_WORKFLOW_REQUIREMENTS.md)
- [DEPLOY_WORKFLOW_REQUIREMENTS.md](./DEPLOY_WORKFLOW_REQUIREMENTS.md)
- [CLEANUP_WORKFLOW_REQUIREMENTS.md](./CLEANUP_WORKFLOW_REQUIREMENTS.md)

## 6. Validate And Operate

Before delegating or mentioning work, run the built-in preflight:

```bash
patchrelay doctor
```

For a foreground manual start:

```bash
patchrelay serve
```

Stay in the terminal:

```bash
patchrelay project apply your-project /absolute/path/to/repo
patchrelay installations
patchrelay inspect APP-123
```

`patchrelay project apply` opens the browser only long enough to approve the Linear OAuth app when it needs a fresh installation, then returns to the CLI workflow.

## 7. Run As A Service

Create and start the user service with:

```bash
patchrelay install-service
```

That writes:

- `~/.config/systemd/user/patchrelay.service`
- `~/.config/systemd/user/patchrelay-reload.service`
- `~/.config/systemd/user/patchrelay.path`

And then runs:

- `systemctl --user daemon-reload`
- `systemctl --user enable --now patchrelay.path`
- `systemctl --user enable patchrelay.service`
- `systemctl --user reload-or-restart patchrelay.service`

If you only want to write the unit files without starting them yet:

```bash
patchrelay install-service --write-only
systemctl --user daemon-reload
systemctl --user enable --now patchrelay.path
systemctl --user enable patchrelay.service
systemctl --user reload-or-restart patchrelay.service
```

After package updates, restart PatchRelay with:

```bash
patchrelay restart-service
```

## 8. Security Posture

Recommended production posture:

- bind to loopback unless you have a strong reason not to
- expose only `/`, `/health`, `/ready`, `/oauth/linear/callback`, and `POST /webhooks/linear`
- leave `operator_api.enabled` disabled unless you explicitly need the HTTP operator endpoints
- require `PATCHRELAY_OPERATOR_TOKEN` if you enable the operator API on a non-loopback bind
- treat workflow files and Codex runtime access as privileged automation policy
- configure `trusted_actors` for every project that should only be driven by a known owner or trusted group

Use [../SECURITY.md](../SECURITY.md) for the security policy.
