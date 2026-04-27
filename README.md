# PatchRelay

Self-hosted toolkit for shipping code with agents: a Linear-driven harness that runs Codex sessions inside your real repos, plus two GitHub-native services that review PRs and deliver them through a merge queue. Each component works on its own, and they communicate only through GitHub.

## The stack

This repository ships **three independent services**. Install one, two, or all three.

| Service | Package | Role |
|-|-|-|
| [`patchrelay`](./) | `npm install -g patchrelay` | Linear-driven harness that runs Codex sessions inside your real repos. Fully autonomous on webhooks: implementation, review fix, CI repair, queue repair. |
| [`review-quill`](./packages/review-quill) | `npm install -g review-quill` | GitHub PR review bot. Reviews every merge-ready head from a real local checkout and posts a normal `APPROVE` / `REQUEST_CHANGES` review. |
| [`merge-steward`](./packages/merge-steward) | `npm install -g merge-steward` | Serial merge queue. Speculatively integrates approved PRs on top of the latest `main`, runs CI on the integrated SHA, and fast-forwards `main` only when that tested result is green. |

Common setups:

- **Full autonomy** — all three. PatchRelay implements from a Linear issue, review-quill reviews, merge-steward delivers. No human in the room.
- **Supervised delivery** — `review-quill` + `merge-steward` without PatchRelay, driven by your own agent (Claude Code, Cursor, Codex CLI, …). See [Use with your own agent](#use-with-your-own-agent).
- **Queue only** or **review only** — run either downstream service on its own if you already have the other half of the story.

### What this buys you

- **PRs ship tested against the latest `main`.** The queue re-validates on the integrated SHA at admission time, and retries if `main` moves during validation. No more "green yesterday, broken today."
- **Many PR failures have mechanical fixes an agent can handle.** Requested changes like a rename, a missing null check, a new test, refreshing against `main`, resolving a conflict surfaced by speculation, or rerunning a flaky job. Both services publish structured failure reasons (inline review comments, failing check names, queue incidents) an agent can act on directly.
- **No prerequisites beyond GitHub.** A GitHub App, a webhook, and `npm install -g` per service.

## Use with your own agent

For supervised delivery — an agent you drive from Claude Code / Cursor / Codex iterating on PRs in real time — install the [`ship-pr`](https://github.com/krasnoperov/patchrelay-agents) skill from the companion marketplace:

```
/plugin marketplace add krasnoperov/patchrelay-agents
/plugin install ship-pr@patchrelay
```

`ship-pr` teaches the agent to block on `review-quill pr status --wait` and `merge-steward pr status --wait`, read structured failure reasons on exit `2`, fix the code, push, and re-enter the wait. No polling loop, no LLM-judged "is it done yet?". See [patchrelay-agents](https://github.com/krasnoperov/patchrelay-agents) for more.

## Quick start (PatchRelay harness)

Prerequisites:

- Linux with shell access, Node.js `24+`
- `git` and `codex` (authenticated for the same user that will run PatchRelay)
- a Linear OAuth app and webhook secret
- a public HTTPS entrypoint (Caddy, nginx, tunnel) so Linear and GitHub can reach your webhooks

```bash
npm install -g patchrelay
patchrelay init https://patchrelay.example.com
```

`init` writes the local config, env files, and systemd unit. Edit `~/.config/patchrelay/service.env` to fill in the Linear OAuth client id and secret (the webhook secret and token-encryption key are generated for you). Then:

```bash
patchrelay linear connect                              # one-time Linear OAuth
patchrelay linear sync                                 # cache teams/projects
patchrelay repo link krasnoperov/usertold \
    --workspace usertold --team USE                    # link a GitHub repo
patchrelay doctor                                      # validate
patchrelay service status
patchrelay dashboard
```

Each repo needs two workflow files for repo-specific run behavior:

- `IMPLEMENTATION_WORKFLOW.md` — implementation, CI repair, queue repair runs
- `REVIEW_WORKFLOW.md` — review fix runs

Keep them short, action-oriented, human-authored. Durable machine-level policy belongs in Codex `developer_instructions`; workflow files are for repo-local behavior and validation. See [prompting.md](./docs/prompting.md) for how the built-in scaffold composes them.

Full install, ingress, and GitHub/Linear app setup: [self-hosting.md](./docs/self-hosting.md). Daily ops and CLI cheatsheet: [operator-guide.md](./docs/operator-guide.md).

## How it works

1. A human delegates an issue to the PatchRelay Linear app.
2. PatchRelay verifies the webhook, routes the issue to the right local repo, prepares a durable worktree, and launches an implementation run through `codex app-server`.
3. PatchRelay persists thread ids, run state, and observations so work stays inspectable and restartable.
4. GitHub webhooks drive reactive repair loops — CI repair on check failures, review fix on requested changes, queue repair on merge-steward evictions.
5. `review-quill` reviews ready PRs; `merge-steward` admits approved, green PRs and delivers them by speculative integration.
6. An operator can take over inside the same worktree at any time.

Architecture and failure taxonomy: [architecture.md](./docs/architecture.md). Downstream delivery: [merge-queue.md](./docs/merge-queue.md).

## Downstream services

Two separate services handle review and delivery. Both are independent, GitHub-native, and usable without PatchRelay.

### review-quill

Watches PRs and posts ordinary GitHub reviews from a real local checkout of the PR head. By default reviews as soon as the head updates; can optionally wait for configured checks to go green first.

```bash
review-quill init https://review.example.com
review-quill repo attach owner/repo
review-quill doctor --repo repo
```

See the [review-quill package README](./packages/review-quill/README.md) for the pitch and quick start, or [docs/review-quill.md](./docs/review-quill.md) for the full operator reference.

### merge-steward

Serial merge queue with speculative integration. Builds a speculative merge branch for each approved PR on top of the current queue base, runs CI on that integrated SHA, and fast-forwards `main` only when the tested result is still valid. Evictions produce a durable incident and a GitHub check run — the signal an agent uses to trigger a repair.

```bash
merge-steward init https://queue.example.com
merge-steward attach owner/repo --base-branch main
merge-steward doctor --repo repo
merge-steward service status
```

See the [merge-steward package README](./packages/merge-steward/README.md) for the pitch and quick start, [docs/merge-steward.md](./docs/merge-steward.md) for the full operator reference, or [docs/merge-queue.md](./docs/merge-queue.md) for the two-service overview.

## Docs

- [Self-hosting and deployment](./docs/self-hosting.md) — install, ingress, OAuth and GitHub App setup
- [Architecture](./docs/architecture.md) — components, ownership, state machine, failure taxonomy
- [Operator guide](./docs/operator-guide.md) — daily loop, CLI cheatsheet, troubleshooting
- [Merge queue](./docs/merge-queue.md) — the two-service delivery story
- [Prompting](./docs/prompting.md) — how workflow files and the built-in scaffold compose
- [Secrets](./docs/secrets.md) — systemd credentials, resolution order
- [review-quill reference](./docs/review-quill.md) · [merge-steward reference](./docs/merge-steward.md)
- [Product specs](./docs/product-specs/index.md) · [Design docs](./docs/design-docs/index.md) · [Core beliefs](./docs/design-docs/core-beliefs.md)
- [Contributing](./CONTRIBUTING.md) · [Security policy](./SECURITY.md)

## Status

PatchRelay is usable now, but still early and opinionated. The focus is a strong self-hosted harness for Linear + Codex work, not a generalized SaaS control plane.
