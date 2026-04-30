# Self-Hosting PatchRelay

## Purpose

This is the canonical install and runtime guide for PatchRelay.

PatchRelay is designed to run on infrastructure you control, close to the repositories and deployment surface that Codex needs to access. In harness terms, self-hosting matters because PatchRelay is the execution system around the model: it routes work, prepares durable workspaces, carries forward state, and keeps runs inspectable in the real environment where the code lives.

For the architecture overview, see [architecture.md](./architecture.md).

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
3. Caddy or another reverse proxy provides the public HTTPS entrypoint Linear and GitHub can reach.
4. Only `/`, `/health`, `/ready`, `/oauth/linear/callback`, `POST /webhooks/linear`, and `POST /webhooks/github` are published.
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
- one GitHub App and webhook secret if PatchRelay should observe PR, review, check, and push events for reactive repair loops

## Public Ingress

Linear and GitHub cannot call a service that only exists on loopback, so the normal setup needs both:

- PatchRelay bound locally, usually `127.0.0.1:8787`
- a public HTTPS domain such as `https://patchrelay.example.com` forwarded to that local service by Caddy, nginx, or a tunnel

PatchRelay should know that public origin through `server.public_base_url`.

By default PatchRelay derives the OAuth callback as:

- `${server.public_base_url}/oauth/linear/callback`

The callback path is fixed and must remain `/oauth/linear/callback`.

## 1. Install PatchRelay

```bash
pnpm add -g patchrelay
```

If you are installing from a local source checkout instead of the package registry:

```bash
pnpm install --frozen-lockfile
pnpm pack
pnpm add -g ./patchrelay-*.tgz
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
- `/etc/systemd/system/patchrelay.service`

Default runtime paths are:

- config: `~/.config/patchrelay/`
- database: `~/.local/state/patchrelay/patchrelay.sqlite`
- logs: `~/.local/state/patchrelay/patchrelay.log`
- worktree roots: usually `~/.local/share/patchrelay/worktrees/<project>`

The generated `patchrelay.json` stays intentionally minimal. In the default setup it only needs `server.public_base_url`; PatchRelay already has built-in defaults for the local bind address, database path, logs, worktree roots, workflow filenames, and Codex runner settings.

If you need durable machine-level Codex policy for every repository on this PatchRelay install, set it under `runner.codex.developer_instructions`. PatchRelay appends those local instructions after its built-in harness rules.

For day-to-day operations and troubleshooting after install, see [operator-guide.md](./operator-guide.md).

## 3. Configure Machine-Level Secrets

PatchRelay resolves secrets through a provider-agnostic fallback chain — see [secrets.md](./secrets.md) for the full reference.

**Quick start (dev / getting started):** edit `~/.config/patchrelay/service.env`:

```bash
LINEAR_WEBHOOK_SECRET=generated-by-patchrelay-init
PATCHRELAY_TOKEN_ENCRYPTION_KEY=generated-by-patchrelay-init
LINEAR_OAUTH_CLIENT_ID=replace-with-linear-oauth-client-id
LINEAR_OAUTH_CLIENT_SECRET=replace-with-linear-oauth-client-secret
```

For GitHub webhook intake and bot identity, also configure:

```bash
GITHUB_APP_WEBHOOK_SECRET=replace-with-github-app-webhook-secret
PATCHRELAY_GITHUB_APP_ID=replace-with-github-app-id
PATCHRELAY_GITHUB_APP_PRIVATE_KEY_FILE=/path/to/github-app-private-key.pem
# Optional; omit to let PatchRelay discover the installation.
PATCHRELAY_GITHUB_APP_INSTALLATION_ID=replace-with-installation-id
```

**Production:** encrypt secrets with `systemd-creds` and load them via `LoadCredentialEncrypted=` in the system service unit. This removes all plaintext secrets from disk and makes them invisible to user-level processes. See [secrets.md](./secrets.md) for step-by-step setup and rotation.

Optional non-secret overrides such as `PATCHRELAY_CONFIG`, `PATCHRELAY_DB_PATH`, and `PATCHRELAY_LOG_FILE` belong in `~/.config/patchrelay/runtime.env`. In personal-mode, prefer user-owned paths over `/opt` or `/var` paths.

Keep these values machine-level. They belong in PatchRelay's own config files, not inside repository `.env` files.

Configure the Linear OAuth app settings and webhook categories in your Linear workspace settings. Configure the GitHub App webhook to send PR, review, check suite, check run, and push events to `${server.public_base_url}/webhooks/github`.

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

Connect PatchRelay to a Linear workspace first:

```bash
patchrelay linear connect
patchrelay linear sync
```

Then link repositories by GitHub repo identity:

```bash
patchrelay repo link krasnoperov/usertold --workspace usertold --team USE
```

A linked repository needs:

- `github_repo`
- `local_path` (managed automatically unless you override it with `--path`)
- the Linear workspace name/key/id
- one or more routing keys: `linear_team_ids`, and optionally `linear_project_ids`

`patchrelay repo link` is the idempotent happy-path command:

- it creates or updates the local repository entry
- it refreshes the chosen Linear workspace catalog before resolving teams/projects
- it verifies or creates the managed local clone
- it reloads the service when it can
- if workflow files or secrets are still missing, it tells you what to fix and can be rerun safely

Default trigger events for app-mode installs: `delegateChanged`, `statusChanged`, `agentSessionCreated`, `agentPrompted`, `commentCreated`, and `commentUpdated`.

The managed local clone root defaults to `~/projects`. Issue worktrees still default to `~/.local/share/patchrelay/worktrees/<repo-name>`. `branch_prefix` defaults to the GitHub repo name.

If you want Linear itself to be part of your trust boundary, configure `trusted_actors` on each project. That allowlist can name specific owners by `id` or `email`, or define a group-style allowlist with `email_domains`.

## 5. Add Repo-Local Workflow Docs

Each automated repository should contain:

- `IMPLEMENTATION_WORKFLOW.md` — guidance for implementation, CI repair, and queue repair runs
- `REVIEW_WORKFLOW.md` — guidance for review fix runs

These files are the repo-local workflow guidance PatchRelay points Codex at during each run. They should explain what the agent is allowed to do in that repository, what validation is required, and how to finish the work.

Keep workflow files short and action-oriented. Durable install-wide policy belongs in `runner.codex.developer_instructions`; workflow files should stay focused on repo-specific behavior and validation.

## 6. Validate

Before delegating or mentioning work, run the built-in preflight:

```bash
patchrelay doctor
```

For a foreground manual start:

```bash
patchrelay serve
```

`patchrelay linear connect` opens the browser only long enough to approve the Linear OAuth app when it needs a fresh workspace installation, then returns to the CLI. `patchrelay repo link` reuses that saved workspace installation without opening the browser again.

Daily operations (dashboard, issue inspection, takeover, troubleshooting, log fields) are covered in [operator-guide.md](./operator-guide.md).

## 7. Run As A Service

Create and start the system service with:

```bash
patchrelay service install
```

That writes:

- `/etc/systemd/system/patchrelay.service`

And then runs:

- `sudo systemctl daemon-reload`
- `sudo systemctl enable patchrelay.service`
- `sudo systemctl reload-or-restart patchrelay.service`

If you only want to write the unit files without starting them yet:

```bash
patchrelay service install --write-only
sudo systemctl daemon-reload
sudo systemctl enable patchrelay.service
sudo systemctl reload-or-restart patchrelay.service
```

After package updates, restart PatchRelay with:

```bash
patchrelay service restart
```

## 8. Security Posture

Recommended production posture:

- bind to loopback unless you have a strong reason not to
- expose only `/`, `/health`, `/ready`, `/oauth/linear/callback`, `POST /webhooks/linear`, and `POST /webhooks/github`
- leave `operator_api.enabled` disabled unless you explicitly need the HTTP operator endpoints
- require `PATCHRELAY_OPERATOR_TOKEN` if you enable the operator API on a non-loopback bind
- treat workflow files and Codex runtime access as privileged automation policy
- configure `trusted_actors` for every project that should only be driven by a known owner or trusted group

Use [../SECURITY.md](../SECURITY.md) for the security policy.
