# Self-Hosting PatchRelay

## Overview

PatchRelay is designed to run on a machine you control, close to the repositories and deployment surface your agent needs to access.

The common deployment shape is:

1. PatchRelay runs locally and listens on `127.0.0.1:8787`
2. Caddy or another reverse proxy terminates TLS
3. only `/`, `/health`, `/ready`, and `POST /webhooks/linear` are published
4. PatchRelay reads and writes local git repos and worktrees directly
5. Codex runs through `codex app-server` on the same machine

## Prerequisites

- Linux host with shell access
- Node.js 24 or newer
- `git`
- `codex` CLI installed and authenticated for the machine user running PatchRelay
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
- OAuth mode: create a Linear OAuth app and configure its redirect URI to point at PatchRelay, for example `http://127.0.0.1:8787/oauth/linear/callback` during local setup or your public setup URL in production.

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

Optional overrides such as `PATCHRELAY_CONFIG`, `PATCHRELAY_DB_PATH`, and `PATCHRELAY_LOG_FILE` can also live there.

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

Keep `operator_api.enabled: false` unless you explicitly need the local inspection API. If you enable it on anything other than `127.0.0.1`, set `bearer_token_env` and publish it only behind additional access controls.

If you enable Linear OAuth, keep the operator API on and protected so you can use the setup endpoints and installation management routes safely.

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

For OAuth installation mode, open:

```text
http://127.0.0.1:8787/setup
```

or use:

```bash
patchrelay connect --project your-project
patchrelay installations
patchrelay link-installation your-project 1
```

## 7. Run As A Service

The repo includes a generic systemd example in [infra/patchrelay.service](../infra/patchrelay.service). Copy it into `/etc/systemd/system/patchrelay.service`, replace the placeholder paths and user, then run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now patchrelay
```

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

## Recommended Production Defaults

- bind PatchRelay to `127.0.0.1`
- expose only `/`, `/health`, `/ready`, and `POST /webhooks/linear`
- run under a dedicated Unix user
- keep worktrees outside the application checkout
- keep the database on local disk
- store logs in dedicated directories
- enable webhook archival only if you actually need raw payload retention

## Troubleshooting

If PatchRelay starts but does not process issue transitions:

- check that the Linear webhook secret matches
- check that the issue routes to a configured project
- check that the relevant trigger event is enabled
- check that the configured workflow status names exactly match your Linear workflow
- check that `codex app-server` can start for the service user
- run `node dist/index.js doctor` and clear any failing preflight checks

If PatchRelay can read webhooks but cannot write back to Linear:

- verify `LINEAR_API_TOKEN`
- verify the token has permission to read and update issues and comments
- verify the configured active status names and optional labels exist in the Linear workspace
