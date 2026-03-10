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
- either one Linear personal API key or one Linear OAuth app
- one Linear webhook secret

## 1. Clone And Build

```bash
git clone https://github.com/krasnoperov/patchrelay.git
cd patchrelay
npm install
npm run build
```

## 2. Create Runtime Files

```bash
cp .env.example .env
cp config/patchrelay.example.yaml config/patchrelay.yaml
```

## 3. Configure Secrets

Choose one of these modes:

- Legacy mode: create a Linear personal API key in `Linear -> Settings -> API -> Personal API keys`.
- OAuth mode: create a Linear OAuth app and configure its redirect URI to point at PatchRelay, for example `http://127.0.0.1:8787/oauth/linear/callback` for personal-mode local setup or your public callback URL if you later expose it remotely.

Then edit `.env`:

```bash
LINEAR_WEBHOOK_SECRET=replace-with-linear-webhook-secret
LINEAR_API_TOKEN=replace-with-linear-api-token
# or, for OAuth installation mode:
# PATCHRELAY_TOKEN_ENCRYPTION_KEY=replace-with-long-random-secret
# LINEAR_OAUTH_CLIENT_ID=replace-with-linear-oauth-client-id
# LINEAR_OAUTH_CLIENT_SECRET=replace-with-linear-oauth-client-secret
# PATCHRELAY_OPERATOR_TOKEN=replace-with-operator-api-token
```

Optional overrides such as `PATCHRELAY_CONFIG`, `PATCHRELAY_DB_PATH`, and `PATCHRELAY_LOG_FILE` can also live there. In personal-mode, prefer user-owned paths over `/opt` or `/var` paths.

## 4. Configure Projects

Edit `config/patchrelay.yaml` and define one or more projects.

Each project needs:

- a local repository path
- a worktree root
- repo-local workflow files for development, review, deploy, and cleanup
- the Linear statuses that should trigger each stage
- the issue key prefixes or team ids that should route to that project
- a branch prefix

The example config is intentionally verbose so you can adapt it to your own workflow without editing code.

Keep `operator_api.enabled: false` unless you explicitly need the local inspection API. The CLI-first OAuth flow still works on loopback without turning the wider operator API on. If you enable it on anything other than `127.0.0.1`, set `bearer_token_env` and publish it only behind additional access controls.

For the recommended CLI-first flow, you do not need to use `/setup` as a primary control surface. The browser is only needed for Linear OAuth consent after `patchrelay connect`.

## 5. Add Repo-Local Workflow Docs

Each automated repository should contain:

- `IMPLEMENTATION_WORKFLOW.md`
- `REVIEW_WORKFLOW.md`
- `DEPLOY_WORKFLOW.md`
- `CLEANUP_WORKFLOW.md`

These files are the policy PatchRelay passes to the agent. They should explain what the agent is allowed to do in that repository, what validation is required, and when final issue states should be moved.

Requirement references:

- [IMPLEMENTATION_WORKFLOW_REQUIREMENTS.md](IMPLEMENTATION_WORKFLOW_REQUIREMENTS.md)
- [REVIEW_WORKFLOW_REQUIREMENTS.md](REVIEW_WORKFLOW_REQUIREMENTS.md)
- [DEPLOY_WORKFLOW_REQUIREMENTS.md](DEPLOY_WORKFLOW_REQUIREMENTS.md)
- [CLEANUP_WORKFLOW_REQUIREMENTS.md](CLEANUP_WORKFLOW_REQUIREMENTS.md)

## 6. Start PatchRelay

For a manual start:

```bash
npm run start
```

Before enabling the service, run the built-in preflight:

```bash
npm run build
node dist/index.js doctor
```

For development:

```bash
npm run dev
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

For OAuth installation mode, stay in the terminal:

```bash
patchrelay connect --project your-project
patchrelay installations
patchrelay link-installation your-project 1
patchrelay webhook your-project
```

`patchrelay connect` opens the browser only long enough to approve the Linear OAuth app, then returns to the CLI workflow.

## 7. Run As A Service

The repo includes a systemd user-service example in [infra/patchrelay.service](../infra/patchrelay.service). Copy it into `~/.config/systemd/user/patchrelay.service`, replace the placeholder paths, then run:

```bash
systemctl --user daemon-reload
systemctl --user enable --now patchrelay
```

If the machine should keep PatchRelay running after logout, enable lingering for your user once:

```bash
sudo loginctl enable-linger "$USER"
```

This is the preferred mode because Codex, git, SSH, and any repo-specific toolchains then run with your existing user permissions and credentials.
Make sure the unit still has write access to every repository path and worktree root that PatchRelay will manage.

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

## Troubleshooting

If PatchRelay starts but does not process issue transitions:

- check that the Linear webhook secret matches
- check that the issue routes to a configured project
- check that the relevant trigger event is enabled
- check that the configured workflow status names exactly match your Linear workflow
- check that `codex app-server` can start for your user
- run `node dist/index.js doctor` and clear any failing preflight checks

If PatchRelay can read webhooks but cannot write back to Linear:

- verify `LINEAR_API_TOKEN`
- verify the token has permission to read and update issues and comments
- verify the configured active status names and optional labels exist in the Linear workspace
