# Self-Hosting PatchRelay

## Purpose

This is the canonical install and runtime guide for PatchRelay.

PatchRelay is designed to run on infrastructure you control, close to the repositories and deployment surface that Codex needs to access. In harness terms, self-hosting matters because PatchRelay is the execution system around the model: it routes work, prepares durable workspaces, carries forward state, and keeps runs inspectable in the real environment where the code lives.

For the Linear OAuth app and delegation model, use [linear-agent-onboarding.md](./linear-agent-onboarding.md).

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

- `~/.config/patchrelay/.env`
- `~/.config/patchrelay/patchrelay.yaml`
- `~/.config/systemd/user/patchrelay.service`
- `~/.config/systemd/user/patchrelay-reload.service`
- `~/.config/systemd/user/patchrelay.path`

Default runtime paths are:

- config: `~/.config/patchrelay/`
- database: `~/.local/state/patchrelay/patchrelay.sqlite`
- logs: `~/.local/state/patchrelay/patchrelay.log`
- worktree roots: usually `~/.local/share/patchrelay/worktrees/<project>`

The generated `patchrelay.yaml` stays intentionally minimal. In the default setup it only needs `server.public_base_url`; PatchRelay already has built-in defaults for the local bind address, database path, logs, worktree roots, workflow filenames, workflow states, and Codex runner settings.

`patchrelay init` also installs the user service and a watcher that reload-or-restarts PatchRelay whenever `patchrelay.yaml` or `.env` changes.

## 3. Configure Machine-Level Secrets

Edit `~/.config/patchrelay/.env` and keep the generated webhook secret and token-encryption key:

```bash
LINEAR_WEBHOOK_SECRET=generated-by-patchrelay-init
PATCHRELAY_TOKEN_ENCRYPTION_KEY=generated-by-patchrelay-init
LINEAR_OAUTH_CLIENT_ID=replace-with-linear-oauth-client-id
LINEAR_OAUTH_CLIENT_SECRET=replace-with-linear-oauth-client-secret
# PATCHRELAY_OPERATOR_TOKEN=replace-with-operator-api-token
```

Optional overrides such as `PATCHRELAY_CONFIG`, `PATCHRELAY_DB_PATH`, and `PATCHRELAY_LOG_FILE` can also live there. In personal-mode, prefer user-owned paths over `/opt` or `/var` paths.

Keep these values machine-level. They belong in PatchRelay's own `.env`, not inside repository `.env` files.

For the Linear OAuth app settings and webhook categories, use [linear-agent-onboarding.md](./linear-agent-onboarding.md).

## 4. Configure Projects

`patchrelay init` writes only the machine-level service config to `~/.config/patchrelay/patchrelay.yaml`.

At the top level, configure the public HTTPS origin that Linear should use:

```yaml
server:
  public_base_url: https://patchrelay.example.com
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

- by default it looks for `IMPLEMENTATION_WORKFLOW.md`, `REVIEW_WORKFLOW.md`, `DEPLOY_WORKFLOW.md`, and `CLEANUP_WORKFLOW.md` in each repo root
- by default it maps `Start`, `Review`, `Deploy`, `Cleanup`, `Implementing`, `Reviewing`, `Deploying`, `Cleaning Up`, `Human Needed`, and `Done`
- by default it uses `agentSessionCreated`, `agentPrompted`, and `statusChanged` as trigger events for app-mode installs
- `defaults.workflow_files` and `defaults.workflow_statuses` let you change those conventions globally
- `projects[].workflow_files` and `projects[].workflow_statuses` are sparse overrides, so a project only needs to declare the entries that differ
- `worktree_root` defaults to `~/.local/share/patchrelay/worktrees/<project-id>`
- `branch_prefix` defaults to a slug of the project id

`projects[].trigger_events` is optional and mainly for advanced overrides. Keep it only if you want PatchRelay to react to a non-default set such as regular issue comments.

Workflow file paths are resolved relative to `repo_path` unless you provide an absolute path. Optional convention states such as `cleanup`, `cleanup_active`, `human_needed`, and `done` can be disabled for a project by setting them to `null`.

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

Before delegating work, run the built-in preflight:

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
