# PatchRelay

PatchRelay is a self-hosted control plane for Linear-driven software delivery with coding agents.

It listens for signed Linear webhooks, maps issues to local repositories, prepares one durable git worktree per issue, and runs staged Codex turns through `codex app-server`. PatchRelay keeps the tracker state, workspace state, and agent thread history correlated so you can see what happened after the run, not just while it is live.

PatchRelay now supports both:

- legacy single-workspace mode with one `LINEAR_API_TOKEN`
- OAuth installation mode for smoother setup, multiple Linear workspaces, and less manual token handling

## Why This Exists

PatchRelay is built for a very specific operating model:

- issues live in Linear
- the coding agent has full access to your own server and repositories
- one issue gets one durable branch and worktree
- implementation, review, and deploy happen as explicit workflow stages
- deterministic tracker bookkeeping is owned by the service
- judgment-heavy final state transitions are still owned by the agent

That gives you a setup where the agent can work with real tools in a real environment, while the service keeps orchestration, auditability, and handoff state predictable.

## What PatchRelay Does

- verifies and archives Linear webhooks
- maps Linear states such as `Start`, `Review`, and `Deploy` into internal stages
- creates or reuses one issue workspace and branch
- starts or forks Codex threads through `codex app-server`
- writes deterministic active state back to Linear such as `Implementing`, `Reviewing`, and `Deploying`
- maintains a service-owned status comment in Linear
- optionally manages service-owned workflow labels such as `llm-working`
- forwards fresh Linear comments into an active Codex turn
- persists stage reports and raw event history for later inspection

## Public Surface

PatchRelay is meant to be published behind a reverse proxy with only these routes exposed:

- `GET /`
- `GET /health`
- `GET /ready`
- `POST /webhooks/linear`

Internal inspection endpoints are disabled by default. If you enable the optional operator API, keep it local or protect it with a bearer token.

## Quick Start

1. Install prerequisites:
   - Linux machine or VM you control
   - Node.js 24+
   - `git`
   - `codex` CLI installed and authenticated
   - either a Linear personal API key or a Linear OAuth app
   - a Linear webhook secret

2. Clone and install:

```bash
git clone https://github.com/krasnoperov/patchrelay.git
cd patchrelay
npm install
npm run build
```

3. Create local config:

```bash
cp .env.example .env
cp config/patchrelay.example.yaml config/patchrelay.yaml
```

4. Edit `.env` and `config/patchrelay.yaml` for your machine, repos, worktree roots, workflow docs, and Linear team/status names.
   - For legacy mode, set `LINEAR_API_TOKEN`.
   - For OAuth mode, set `PATCHRELAY_TOKEN_ENCRYPTION_KEY`, `LINEAR_OAUTH_CLIENT_ID`, and `LINEAR_OAUTH_CLIENT_SECRET`.

5. Start PatchRelay:

```bash
npm run start
```

Before putting it in service, run:

```bash
npm run build
node dist/index.js doctor
```

For OAuth mode, you can then connect Linear from the local setup surface or CLI:

```bash
patchrelay connect --project your-project
patchrelay installations
```

6. Put it behind Caddy, nginx, or another reverse proxy that exposes only `/`, `/health`, `/ready`, and `POST /webhooks/linear`.

For a fuller install walkthrough, see [docs/self-hosting.md](docs/self-hosting.md).

## Workflow Model

PatchRelay assumes repo-local workflow docs such as:

- `IMPLEMENTATION_WORKFLOW.md`
- `REVIEW_WORKFLOW.md`
- `DEPLOY_WORKFLOW.md`
- `CLEANUP_WORKFLOW.md`

These docs tell the agent how to work in that repository. PatchRelay injects the relevant file into each turn and owns the deterministic bookkeeping around active Linear states, service comments, and optional workflow labels.

The requirement docs for those files live in:

- [docs/IMPLEMENTATION_WORKFLOW_REQUIREMENTS.md](docs/IMPLEMENTATION_WORKFLOW_REQUIREMENTS.md)
- [docs/REVIEW_WORKFLOW_REQUIREMENTS.md](docs/REVIEW_WORKFLOW_REQUIREMENTS.md)
- [docs/DEPLOY_WORKFLOW_REQUIREMENTS.md](docs/DEPLOY_WORKFLOW_REQUIREMENTS.md)
- [docs/CLEANUP_WORKFLOW_REQUIREMENTS.md](docs/CLEANUP_WORKFLOW_REQUIREMENTS.md)

## Docs

- [PRODUCT_SPEC.md](PRODUCT_SPEC.md): product goals and external behavior
- [docs/architecture.md](docs/architecture.md): internal model and request flow
- [docs/codex-workflow.md](docs/codex-workflow.md): how PatchRelay uses `codex app-server`
- [docs/self-hosting.md](docs/self-hosting.md): installation and deployment guide
- [docs/cli-spec.md](docs/cli-spec.md): operator CLI design

## Security Notes

- Keep PatchRelay bound to `127.0.0.1` unless you have a strong reason not to.
- Publish only `/`, `/health`, `/ready`, and `POST /webhooks/linear`.
- Leave the operator API disabled unless you need it. If you enable it on a non-local bind, require a bearer token.
- Give the Linear API token only the access needed to update issues and comments in the target workspace.
- Treat repo-local workflow docs as code execution policy, because PatchRelay passes them directly into agent turns.

## Status

PatchRelay is usable now, but still opinionated and early. The current focus is a solid self-hosted workflow for operators who want issue-driven automation on their own machines and servers, not a generalized SaaS product.
