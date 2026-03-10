# PatchRelay

PatchRelay is a self-hosted control plane for Linear-driven software delivery with coding agents.

It listens for signed Linear webhooks, maps issues to local repositories, prepares one durable git worktree per issue, and runs staged Codex turns through `codex app-server`. PatchRelay keeps the tracker state, workspace state, and agent thread history correlated so you can see what happened after the run, not just while it is live.

PatchRelay uses one Linear setup model: OAuth-backed installations linked to projects through the CLI.

The recommended operator model is now personal-mode on a machine you control:

- run PatchRelay as your own Unix user
- let Codex inherit that user's existing git, SSH, and local tool permissions
- use the `patchrelay` CLI as the primary operator interface
- use the browser only for Linear OAuth consent

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

Internal inspection endpoints are disabled by default. The CLI-first OAuth flow still works on loopback without exposing the wider operator API. If you enable the optional operator API, keep it local or protect it with a bearer token.

## Quick Start

1. Install prerequisites:
   - Linux machine or VM you control
   - Node.js 24+
   - `git`
   - `codex` CLI installed and authenticated for the same Unix user that will run PatchRelay
   - a Linear OAuth app
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

4. Edit `.env` and `config/patchrelay.yaml` for your machine, repos, worktree roots, and Linear routing.
   - Set `PATCHRELAY_TOKEN_ENCRYPTION_KEY`, `LINEAR_OAUTH_CLIENT_ID`, and `LINEAR_OAUTH_CLIENT_SECRET`.
   - Standard workflow doc names and state names are built in. Use top-level `defaults` to change those conventions globally, and project-level `workflow_files` or `workflow_statuses` only when a repo needs overrides.

5. Start PatchRelay as your own user:

```bash
npm run start
```

Before putting it in service, run:

```bash
npm run build
node dist/index.js doctor
```

Use the CLI as the primary operator interface:

```bash
patchrelay connect --project your-project
patchrelay installations
patchrelay link-installation your-project 1
patchrelay webhook your-project
```

`patchrelay connect` opens the browser only to complete Linear OAuth consent and then returns you to the terminal workflow.

6. Put it behind Caddy, nginx, or another reverse proxy that exposes only `/`, `/health`, `/ready`, and `POST /webhooks/linear`.

For a fuller install walkthrough, see [docs/self-hosting.md](docs/self-hosting.md).

## Workflow Model

PatchRelay assumes repo-local workflow docs such as:

- `IMPLEMENTATION_WORKFLOW.md`
- `REVIEW_WORKFLOW.md`
- `DEPLOY_WORKFLOW.md`
- `CLEANUP_WORKFLOW.md`

These docs tell the agent how to work in that repository. PatchRelay injects the relevant file into each turn and owns the deterministic bookkeeping around active Linear states, service comments, and optional workflow labels.

By default, PatchRelay looks for those four filenames in each repo root and uses the conventional Linear states `Start`, `Review`, `Deploy`, `Cleanup`, `Implementing`, `Reviewing`, `Deploying`, `Cleaning Up`, `Human Needed`, and `Done`. Keep those defaults if they fit your workflow, set top-level `defaults` if you want one shared convention across projects, or override `workflow_files` / `workflow_statuses` on a specific project when it needs custom automation.

Workflow file paths are resolved relative to each project's `repo_path` unless you provide an absolute path. Optional inherited statuses such as `cleanup`, `cleanup_active`, `human_needed`, and `done` can be disabled for a project with `null`.

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
- [docs/cli-spec.md](docs/cli-spec.md): CLI-first operator workflow

## Security Notes

- Keep PatchRelay bound to `127.0.0.1` unless you have a strong reason not to.
- Publish only `/`, `/health`, `/ready`, and `POST /webhooks/linear`.
- Run PatchRelay as your own user if you want Codex to inherit your existing git, SSH, and local tool access.
- Leave the operator API disabled unless you need it. If you enable it on a non-local bind, require a bearer token.
- Keep the Linear OAuth app scopes limited to the issue and comment access PatchRelay actually needs.
- Treat repo-local workflow docs as code execution policy, because PatchRelay passes them directly into agent turns.
- If you use Linear as a control surface, configure `projects[].trusted_actors` so only trusted owners or trusted email domains can trigger or steer automation for that project.

## Trust Model

PatchRelay has three separate trust boundaries:

- Public ingress: only signed Linear webhooks should reach the public service surface.
- Operator control: setup, inspection, and installation-linking should stay local or behind operator auth.
- Linear actor trust: even valid signed webhooks are ignored for a project if their Linear actor is not in that project's `trusted_actors` allowlist.

By default, if `trusted_actors` is omitted, PatchRelay preserves the existing behavior and accepts any valid actor in the routed Linear workspace. If `trusted_actors` is configured for a project, the webhook actor must match by `id`, `name`, `email`, or `email_domain` or the event is ignored before it can queue a stage or steer a live comment.

## Status

PatchRelay is usable now, but still opinionated and early. The current focus is a solid self-hosted workflow for operators who want issue-driven automation on their own machines and servers, not a generalized SaaS product.
