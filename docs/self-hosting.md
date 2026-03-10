# Self-Hosting PatchRelay

## Overview

PatchRelay is designed to run on a machine you control, close to the repositories and deployment surface your agent needs to access.

The recommended deployment mode is personal-mode:

1. PatchRelay runs as your real Unix user
2. Codex inherits that user's existing git, SSH, shell, and repo permissions
3. the `patchrelay` CLI is the primary operator interface
4. the browser is used only to approve Linear OAuth consent
5. PatchRelay itself still listens locally on `127.0.0.1:8787`

The common deployment shape is:

1. PatchRelay runs locally and listens on `127.0.0.1:8787`
2. `patchrelay` CLI drives setup, installation linking, and inspection
3. Caddy or another reverse proxy terminates TLS if you need public webhook ingress
4. only `/`, `/health`, `/ready`, and `POST /webhooks/linear` are published
5. PatchRelay reads and writes local git repos and worktrees directly
6. Codex runs through `codex app-server` on the same machine under the same user

## Prerequisites

- Linux host with shell access
- Node.js 24 or newer
- `git`
- `codex` CLI installed and authenticated for the same user who will run PatchRelay
- access to the local repositories you want to automate
- Linear workspace access
- one Linear OAuth app
- one Linear webhook secret

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
patchrelay init
```

This creates:

- `~/.config/patchrelay/.env`
- `~/.config/patchrelay/patchrelay.yaml`

Default runtime paths are:

- config: `~/.config/patchrelay/`
- database: `~/.local/state/patchrelay/patchrelay.sqlite`
- logs: `~/.local/state/patchrelay/patchrelay.log`
- worktree roots: usually `~/.local/share/patchrelay/worktrees/<project>`

## 3. Configure Secrets

Create a Linear OAuth app and configure its redirect URI to point at PatchRelay, for example `http://127.0.0.1:8787/oauth/linear/callback` for personal-mode local setup or your public callback URL if you later expose it remotely.

Then edit `~/.config/patchrelay/.env`:

```bash
LINEAR_WEBHOOK_SECRET=replace-with-linear-webhook-secret
PATCHRELAY_TOKEN_ENCRYPTION_KEY=replace-with-long-random-secret
LINEAR_OAUTH_CLIENT_ID=replace-with-linear-oauth-client-id
LINEAR_OAUTH_CLIENT_SECRET=replace-with-linear-oauth-client-secret
# PATCHRELAY_OPERATOR_TOKEN=replace-with-operator-api-token
```

Optional overrides such as `PATCHRELAY_CONFIG`, `PATCHRELAY_DB_PATH`, and `PATCHRELAY_LOG_FILE` can also live there. In personal-mode, prefer user-owned paths over `/opt` or `/var` paths.

## 4. Configure Projects

Edit `~/.config/patchrelay/patchrelay.yaml` and define one or more projects.

Each project needs:

- a local repository path
- a worktree root
- the issue key prefixes or team ids that should route to that project
- a branch prefix

PatchRelay is convention-first here:

- by default it looks for `IMPLEMENTATION_WORKFLOW.md`, `REVIEW_WORKFLOW.md`, `DEPLOY_WORKFLOW.md`, and `CLEANUP_WORKFLOW.md` in each repo root
- by default it maps `Start`, `Review`, `Deploy`, `Cleanup`, `Implementing`, `Reviewing`, `Deploying`, `Cleaning Up`, `Human Needed`, and `Done`
- `defaults.workflow_files` and `defaults.workflow_statuses` let you change those conventions globally
- `projects[].workflow_files` and `projects[].workflow_statuses` are sparse overrides, so a project only needs to declare the entries that differ

Workflow file paths are resolved relative to `repo_path` unless you provide an absolute path. Optional convention states such as `cleanup`, `cleanup_active`, `human_needed`, and `done` can be disabled for a project by setting them to `null`.

Keep `operator_api.enabled: false` unless you explicitly need the issue inspection API. The CLI-first OAuth flow still works on loopback because the local management routes for OAuth and installation linking remain available there without turning the wider inspection API on. If you enable the inspection API on anything other than `127.0.0.1`, set `bearer_token_env` and publish it only behind additional access controls.

The browser is only needed for Linear OAuth consent after `patchrelay connect`.

If you want Linear itself to be part of your trust boundary, configure `trusted_actors` on each project. That allowlist can name specific owners by `id` or `email`, or define a group-style allowlist with `email_domains`. When `trusted_actors` is present, unmatched Linear actors are ignored before they can trigger stages or steer a live comment.

## 5. Add Repo-Local Workflow Docs

Each automated repository should contain:

- `IMPLEMENTATION_WORKFLOW.md`
- `REVIEW_WORKFLOW.md`
- `DEPLOY_WORKFLOW.md`
- `CLEANUP_WORKFLOW.md`

These files are the policy PatchRelay passes to the agent. They should explain what the agent is allowed to do in that repository, what validation is required, and when final issue states should be moved.

If every repo follows the standard filenames above, you do not need to repeat `workflow_files` in each project config.

Requirement references:

- [IMPLEMENTATION_WORKFLOW_REQUIREMENTS.md](IMPLEMENTATION_WORKFLOW_REQUIREMENTS.md)
- [REVIEW_WORKFLOW_REQUIREMENTS.md](REVIEW_WORKFLOW_REQUIREMENTS.md)
- [DEPLOY_WORKFLOW_REQUIREMENTS.md](DEPLOY_WORKFLOW_REQUIREMENTS.md)
- [CLEANUP_WORKFLOW_REQUIREMENTS.md](CLEANUP_WORKFLOW_REQUIREMENTS.md)

## 6. Start PatchRelay

Before enabling the service, run the built-in preflight:

```bash
patchrelay doctor
```

For a foreground manual start:

```bash
patchrelay serve
```

For development:

```bash
node --watch --experimental-transform-types src/index.ts
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

Stay in the terminal:

```bash
patchrelay connect --project your-project
patchrelay installations
patchrelay link-installation your-project 1
patchrelay webhook your-project
```

`patchrelay connect` opens the browser only long enough to approve the Linear OAuth app, then returns to the CLI workflow.

## 7. Run As A Service

Create and start the user service with:

```bash
patchrelay install-service
```

That writes `~/.config/systemd/user/patchrelay.service`, reloads the user unit set, and enables + starts `patchrelay`.

If you only want to write the unit file without starting it yet:

```bash
patchrelay install-service --write-only
systemctl --user daemon-reload
systemctl --user enable --now patchrelay
```

If the machine should keep PatchRelay running after logout, enable lingering for your user once:

```bash
sudo loginctl enable-linger "$USER"
```

This is the preferred mode because Codex, git, SSH, and any repo-specific toolchains then run with your existing user permissions and credentials.
Make sure the unit still has write access to every repository path and worktree root that PatchRelay will manage.

After package updates, restart PatchRelay with:

```bash
patchrelay restart-service
```

That runs `systemctl --user daemon-reload` and `systemctl --user restart patchrelay` for you. If you changed the unit manually, re-run `patchrelay install-service --force` first.

## 8. Publish Through Caddy

The repo includes a generic Caddy example in [infra/Caddyfile](../infra/Caddyfile).

Keep the published surface minimal:

- `GET /`
- `GET /health`
- `GET /ready`
- `POST /webhooks/linear`

Everything else should return `404`.

## 9. Configure The Linear Webhook

Point your Linear webhook at:

```text
https://your-domain.example/webhooks/linear
```

Use the same signing secret you placed in `.env`.

At minimum, PatchRelay is useful with status change events. Comment events are also useful because PatchRelay can steer an active turn with fresh Linear comments.

## 10. Optional Labels

If you want PatchRelay to manage workflow labels, create them first in Linear and then reference them in `workflow_labels`:

- `working`
- `awaiting_handoff`

PatchRelay only manages explicitly configured labels and ignores missing labels with a warning.

## Operational Notes

- PatchRelay creates one durable branch and worktree per issue lifecycle.
- Existing issue worktrees are reused across stages.
- PatchRelay owns deterministic active-state bookkeeping in Linear.
- The agent still owns judgment-heavy final transitions such as `Review`, `Deploy`, `Done`, and `Human Needed`.
- If a stage finishes without moving the issue out of the active state, PatchRelay marks the issue as awaiting final handoff instead of silently calling the workflow done.
- The browser is not the main admin surface in personal-mode; the CLI is.

## Recommended Production Defaults

- bind PatchRelay to `127.0.0.1`
- expose only `/`, `/health`, `/ready`, and `POST /webhooks/linear`
- run it as your own Unix user so Codex inherits your existing permissions
- keep worktrees outside the application checkout
- keep the database on local disk in a user-owned path
- store logs in user-owned directories
- enable webhook archival only if you actually need raw payload retention
- configure `trusted_actors` for every project that should only be driven by a known owner or trusted group

## Security Model

Think about PatchRelay as three linked control planes:

1. Web ingress: your reverse proxy should expose only the minimal webhook surface.
2. Operator control: CLI-first setup and inspection stay local or behind explicit operator auth.
3. Linear trust: `trusted_actors` decides who in Linear is allowed to trigger or steer automation once the webhook is already valid.

That last layer matters because a valid signed webhook only proves the event came from Linear, not that the human or integration behind the event is one you want influencing a privileged local agent.

## Troubleshooting

If PatchRelay starts but does not process issue transitions:

- check that the Linear webhook secret matches
- check that the issue routes to a configured project
- check that the relevant trigger event is enabled
- check that the configured workflow status names exactly match your Linear workflow
- check that `codex app-server` can start for your user
- run `patchrelay doctor` and clear any failing preflight checks

If PatchRelay can read webhooks but cannot write back to Linear:

- verify the connected installation is linked to the project
- verify the OAuth app scopes cover reading and updating issues and comments
- verify the configured active status names and optional labels exist in the Linear workspace
