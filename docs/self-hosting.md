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
2. `patchrelay` CLI drives setup, app authorization, and inspection
3. Caddy or another reverse proxy provides the public HTTPS entrypoint Linear can reach
4. only `/`, `/health`, `/ready`, `/oauth/linear/callback`, and `POST /webhooks/linear` are published
5. PatchRelay reads and writes local git repos and worktrees directly
6. Codex runs through `codex app-server` on the same machine under the same user

## Public Ingress

Linear cannot call a service that only exists on your loopback interface.

In the normal setup you need both:

- PatchRelay bound locally, usually `127.0.0.1:8787`
- a public HTTPS domain such as `https://patchrelay.example.com` forwarded to that local service by Caddy, nginx, or a tunnel

PatchRelay should know that public origin through `server.public_base_url`.

By default PatchRelay derives the OAuth callback as:

- `${server.public_base_url}/oauth/linear/callback`

Only set `linear.oauth.redirect_uri` if you want the advanced loopback setup instead:

- `linear.oauth.redirect_uri: http://127.0.0.1:8787/oauth/linear/callback`

The OAuth callback path itself is fixed by PatchRelay and must stay `/oauth/linear/callback`.

## Prerequisites

- Linux host with shell access
- Node.js 24 or newer
- `git`
- `codex` CLI installed and authenticated for the same user who will run PatchRelay
- access to the local repositories you want to automate
- Linear workspace access
- one Linear OAuth app for this PatchRelay deployment
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

Create a Linear OAuth app and configure its redirect URI to point at PatchRelay.

Examples:

- local callback: `http://127.0.0.1:8787/oauth/linear/callback`
- public callback: `https://patchrelay.example.com/oauth/linear/callback`

The callback path is fixed and must remain `/oauth/linear/callback`.

For self-hosting today, you do need your own Linear OAuth app. The good news is that one app can be reused across every project and Linear workspace connected to the same PatchRelay instance.

For PatchRelay's agent-style workflow, configure that Linear OAuth app with:

- `actor=app`
- scopes `read`, `write`, `app:assignable`, and `app:mentionable`
- webhook settings for issue events, comment events, agent session events, permission changes, and inbox notifications pointed at your PatchRelay webhook URL

When those webhook settings are present on the OAuth app, Linear provisions the workspace webhook automatically during app authorization.

In the normal delegated-agent flow, PatchRelay is webhook-driven:

- delegating an issue to the PatchRelay app causes Linear to create an agent session
- Linear delivers `AgentSessionEvent.created` to PatchRelay's webhook URL
- follow-up native agent instructions arrive as `AgentSessionEvent.prompted`
- regular issue comments can also be forwarded into the active run while it is live

PatchRelay does not need to poll Linear to notice delegation in the normal flow.

Then edit `~/.config/patchrelay/.env`:

```bash
LINEAR_WEBHOOK_SECRET=replace-with-linear-webhook-secret
PATCHRELAY_TOKEN_ENCRYPTION_KEY=replace-with-long-random-secret
LINEAR_OAUTH_CLIENT_ID=replace-with-linear-oauth-client-id
LINEAR_OAUTH_CLIENT_SECRET=replace-with-linear-oauth-client-secret
# PATCHRELAY_OPERATOR_TOKEN=replace-with-operator-api-token
```

Optional overrides such as `PATCHRELAY_CONFIG`, `PATCHRELAY_DB_PATH`, and `PATCHRELAY_LOG_FILE` can also live there. In personal-mode, prefer user-owned paths over `/opt` or `/var` paths.

Keep these values machine-level. They belong in PatchRelay's own `.env`, not inside repository `.env` files. If one machine runs one PatchRelay service for several repositories, those repositories normally share the same machine-level Linear secrets while keeping repo-local workflow instructions separate.

## 4. Configure Projects

Edit `~/.config/patchrelay/patchrelay.yaml` and define one or more projects.

At the top level, configure the public HTTPS origin that Linear should use:

```yaml
server:
  bind: 127.0.0.1
  port: 8787
  public_base_url: https://patchrelay.example.com
```

PatchRelay will derive `linear.oauth.redirect_uri` as `https://patchrelay.example.com/oauth/linear/callback`.

Only add an explicit override if you want OAuth to complete on loopback instead:

```yaml
linear:
  oauth:
    redirect_uri: http://127.0.0.1:8787/oauth/linear/callback
```

Each project needs:

- a local repository path
- a worktree root
- the issue key prefixes or team ids that should route to that project
- a branch prefix

For a single-machine multi-repo setup, add one `projects[]` entry per repository. PatchRelay uses those entries for routing and worktree isolation, while the Linear OAuth app, webhook secret, and encrypted installation tokens stay shared at the service level.

PatchRelay is convention-first here:

- by default it looks for `IMPLEMENTATION_WORKFLOW.md`, `REVIEW_WORKFLOW.md`, `DEPLOY_WORKFLOW.md`, and `CLEANUP_WORKFLOW.md` in each repo root
- by default it maps `Start`, `Review`, `Deploy`, `Cleanup`, `Implementing`, `Reviewing`, `Deploying`, `Cleaning Up`, `Human Needed`, and `Done`
- by default it uses `agentSessionCreated`, `agentPrompted`, and `statusChanged` as trigger events for app-mode installs
- `defaults.workflow_files` and `defaults.workflow_statuses` let you change those conventions globally
- `projects[].workflow_files` and `projects[].workflow_statuses` are sparse overrides, so a project only needs to declare the entries that differ

`projects[].trigger_events` is optional now and mainly for advanced overrides. Keep it only if you want PatchRelay to react to a non-default set such as regular issue comments.

Workflow file paths are resolved relative to `repo_path` unless you provide an absolute path. Optional convention states such as `cleanup`, `cleanup_active`, `human_needed`, and `done` can be disabled for a project by setting them to `null`.

Keep `operator_api.enabled: false` unless you explicitly need the issue inspection API. The CLI-first OAuth flow still works on loopback because the local OAuth management routes remain available there without turning the wider inspection API on. If you enable the inspection API on anything other than `127.0.0.1`, set `bearer_token_env` and publish it only behind additional access controls.

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
```

`patchrelay connect` opens the browser only long enough to approve the Linear OAuth app, then returns to the CLI workflow.

When you later add another local repo or PatchRelay project that should reuse the same Linear app installation, run `patchrelay connect --project other-project` again. If PatchRelay sees exactly one saved installation, it links that project locally without another OAuth consent step.

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

Publish these routes:

- `GET /`
- `GET /health`
- `GET /ready`
- `GET /oauth/linear/callback`
- `POST /webhooks/linear`

Everything else should return `404`.

Example:

```caddyfile
{
	email you@example.com
}

patchrelay.example.com {
	encode zstd gzip

	@patchrelay_public {
		path / /health /ready /oauth/linear/callback /webhooks/linear
	}

	handle @patchrelay_public {
		reverse_proxy 127.0.0.1:8787
	}

	handle {
		respond "not found" 404
	}
}
```

## 9. Configure The Linear Webhook

The shared PatchRelay webhook is:

```text
https://your-domain.example/webhooks/linear
```

Use the same signing secret you placed in `.env`.

For the recommended setup, configure those webhook settings on the Linear OAuth app itself so that authorizing the app creates the workspace webhook automatically. That is the supported path for app-actor installs because the app token itself cannot also request Linear admin webhook-management scopes.

At minimum, PatchRelay is useful with delegate changes, status changes, comment events, and agent session events. Comment events and prompted agent sessions are especially useful because PatchRelay can steer an active turn with fresh Linear input.

Linear's newer app-agent docs also recommend subscribing to permission changes and inbox notifications. PatchRelay now accepts those app-level webhooks too so installs stay observable when team access changes or the app starts receiving inbox-style notifications, even though execution still keys off delegation, issue state, comments, and agent sessions.

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
- set `server.public_base_url` to a public HTTPS origin
- expose only `/`, `/health`, `/ready`, `/oauth/linear/callback`, and `POST /webhooks/linear`
- run it as your own Unix user so Codex inherits your existing permissions
- keep worktrees outside the application checkout
- keep the database on local disk in a user-owned path
- store logs in user-owned directories
- enable webhook archival only if you actually need raw payload retention
- configure `trusted_actors` for every project that should only be driven by a known owner or trusted group
- leave `linear.oauth.redirect_uri` unset unless you intentionally want loopback OAuth

## Security Model

Think about PatchRelay as three linked control planes:

1. Web ingress: your reverse proxy should expose only the minimal webhook surface.
2. Operator control: CLI-first setup and inspection stay local or behind explicit operator auth.
3. Linear trust: `trusted_actors` decides who in Linear is allowed to trigger or steer automation once the webhook is already valid.

That last layer matters because a valid signed webhook only proves the event came from Linear, not that the human or integration behind the event is one you want influencing a privileged local agent.

## Troubleshooting

If PatchRelay starts but does not process delegations or stage transitions:

- check that the Linear webhook secret matches
- check that the issue routes to a configured project
- check that the relevant trigger event is enabled
- check that the issue is delegated to the PatchRelay app if you expect the agent-native flow
- check that the configured workflow status names exactly match your Linear workflow
- check that `codex app-server` can start for your user
- run `patchrelay doctor` and clear any failing preflight checks

If PatchRelay can read webhooks but cannot write back to Linear:

- verify the connected installation is linked to the project
- verify the OAuth app scopes cover reading and updating issues and comments, plus `app:assignable` and `app:mentionable` for agent delegation
- verify the Linear app installation still has access to the team(s) your project routes to
- verify the configured active status names and optional labels exist in the Linear workspace
