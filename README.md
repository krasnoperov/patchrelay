# PatchRelay

PatchRelay is a self-hosted harness for delegated Linear work and upkeep of linked pull requests on your own machine.

It receives Linear webhooks, routes issues to the right local repository, prepares durable issue worktrees, runs Codex sessions through `codex app-server`, and keeps the issue loop observable and resumable from the CLI. GitHub webhooks drive reactive loops for CI repair, review fixes, and merge-steward incidents on linked delegated PRs. Separate downstream services own review automation and merge execution.

## The PatchRelay stack

This repository ships **three independent services**. Each one works on its own, communicates through GitHub, and can be paired with any agent or dev workflow:

| Service | Package | Role |
|-|-|-|
| [`patchrelay`](./) | `npm install -g patchrelay` | Linear-driven harness that runs Codex sessions inside your real repos. Fully autonomous on webhooks. |
| [`review-quill`](./packages/review-quill) | `npm install -g review-quill` | GitHub PR review bot. Reviews every merge-ready head from a real local checkout and posts a normal `APPROVE` / `REQUEST_CHANGES` review. |
| [`merge-steward`](./packages/merge-steward) | `npm install -g merge-steward` | Serial merge queue. Speculatively integrates approved PRs on top of the latest `main`, validates, and fast-forwards. Ships PRs **fully tested against the current main**, not the stale base they were opened on. |

You do not have to install all three. Common setups:

- **Full autonomy** — run all three. PatchRelay implements, review-quill reviews, merge-steward delivers. No human in the room.
- **Supervised delivery** — run `review-quill` + `merge-steward` without PatchRelay, and drive them from your own agent (Claude Code, Cursor, Codex CLI, …). See [Use with your own agent](#use-with-your-own-agent) below.
- **Queue only** — run `merge-steward` alone if you already have a review story you are happy with.
- **Review only** — run `review-quill` alone if you already have a merge path you trust.

### Why this combination is transformational

- **PRs ship fully tested against the latest `main`.** The merge queue re-validates on the integrated SHA; no more "green yesterday, broken today."
- **Most PR failures have mechanical fixes.** Reviewer asked for a rename, a missing null check, a new test? Rerun a flaky job? Rebase on `main`? An agent with access to the diff can do all of these without human judgment — and both services surface structured failure reasons (inline review comments, failing check names, queue incidents) that an agent can act on directly.
- **No prerequisites beyond GitHub.** A GitHub App, a webhook, and `npm install -g` per service.

## Use with your own agent

If you want supervised delivery — an agent you drive from Claude Code / Cursor / Codex iterating on PRs in real time — install the [`ship-pr`](https://github.com/krasnoperov/patchrelay-agents) skill from the companion marketplace:

```
/plugin marketplace add krasnoperov/patchrelay-agents
/plugin install ship-pr@patchrelay
```

`ship-pr` teaches the agent to block on `review-quill pr status --wait` and `merge-steward pr status --wait`, read structured failure reasons on exit `2`, fix the code, push, and re-enter the wait. No polling loop, no LLM-judged "is it done yet?" reasoning. See the [patchrelay-agents repo](https://github.com/krasnoperov/patchrelay-agents) for more.

PatchRelay is the system around the model:

- webhook intake and verification (Linear and GitHub)
- Linear OAuth and workspace installations
- issue-to-repo routing
- issue worktree and branch lifecycle
- context packaging, run orchestration, and thread continuity
- reactive CI repair and review fix loops
- queue repair runs triggered by Merge Steward evictions
- native Linear agent input forwarding into active runs
- read-only inspection and run reporting

If you want Codex to work inside your real repos with your real tools, secrets, SSH access, and deployment surface, PatchRelay is the harness that makes that loop reliable.

## Why PatchRelay

- Keep the agent in the real environment instead of rebuilding that environment in a hosted sandbox.
- Use your existing machine, repos, secrets, SSH config, shell tools, and deployment access.
- Keep deterministic workflow logic outside the model: context packaging, routing, run orchestration, worktree ownership, verification, and reporting.
- Choose the Codex approval and sandbox settings that match your risk tolerance.
- Let Linear drive the loop through delegation and native agent sessions.
- Let GitHub drive reactive loops through PR reviews and CI check events.
- Drop into the exact issue worktree and resume control manually when needed.

## What PatchRelay Owns

PatchRelay does the deterministic harness work that you do not want to re-implement around every model run:

- verifies and deduplicates Linear and GitHub webhooks
- maps issue events to the correct local project
- packages the right issue, repo, review, and failure context for each loop
- creates and reuses one durable worktree and branch per issue lifecycle
- starts Codex threads for implementation runs
- triggers reactive runs for CI failures, review feedback, and Merge Steward evictions
- opens and updates PRs for delegated implementation work
- marks its own PRs ready when implementation is complete
- can later repair a linked PR that was opened externally once the issue is delegated
- persists enough state to correlate the Linear issue, local workspace, run, and Codex thread
- reports progress back to Linear and forwards follow-up agent input into active runs
- exposes CLI and optional read-only inspection surfaces so operators can understand what happened

PatchRelay does not own review decisions or queue admission. GitHub is the source of truth for PR readiness, `reviewbot` owns review automation, and [Merge Steward](./packages/merge-steward) owns queueing and merge execution.

## System Layers

PatchRelay works best when read as five layers with clear ownership:

- policy layer: repo workflow files (`IMPLEMENTATION_WORKFLOW.md`, `REVIEW_WORKFLOW.md`)
- coordination layer: issue claiming, run scheduling, retry budgets, and reconciliation
- execution layer: durable worktrees, Codex threads, and queued turn input delivery
- integration layer: Linear webhooks, GitHub webhooks, OAuth, project routing, and state sync
- observability layer: CLI inspection, session status, and operator endpoints

That separation is intentional. PatchRelay is not the policy itself and it is not the coding agent. It is the harness that keeps context, action, verification, and repair coordinated in a real repository with real operational state.

## Runtime Model

PatchRelay is designed for a local, operator-owned setup:

- PatchRelay service runs on your machine or server (default `127.0.0.1:8787`)
- Codex runs through `codex app-server`
- Linear is the control surface
- `patchrelay` CLI is the operator interface
- a reverse proxy exposes the Linear-facing and GitHub-facing webhook routes

Linux and Node.js `24+` are the intended runtime.

You will also need:

- `git`
- `codex`
- a Linear OAuth app for this PatchRelay deployment
- a Linear webhook secret
- a public HTTPS entrypoint such as Caddy, nginx, or a tunnel so Linear and GitHub can reach your PatchRelay webhooks

## How It Works

1. A human delegates PatchRelay on an issue to start automation.
2. PatchRelay verifies the webhook, routes the issue to the right local project, and packages the issue context for the first loop.
3. Delegated issues create or reuse the issue worktree and launch the appropriate first run through `codex app-server`.
4. PatchRelay persists thread ids, run state, and observations so the work stays inspectable and resumable.
5. GitHub webhooks drive reactive verification and repair loops: CI repair on check failures and review fix on changes requested.
6. Implementation issues usually open draft PRs while work is in progress and mark PatchRelay-owned PRs ready when implementation is complete.
7. Downstream automation reacts to GitHub truth: `reviewbot` reviews ready PRs with green CI, and Merge Steward admits ready PRs with green CI and approval into the merge queue.
8. If requested changes, red CI, or a merge-steward incident lands on a linked delegated PR, PatchRelay resumes work on that same PR branch.
9. Native agent prompts and Linear comments can steer the active run. An operator can take over from the exact same worktree when needed.

Not every delegated issue should produce its own PR. Some delegated issues are coordination-only:

- parent trackers that spawn or coordinate child implementation issues
- audit or convergence issues that should wait for child issues before doing a narrow final pass
- planning/specification issues that are complete once the right follow-up issues or decisions exist

In those cases, PatchRelay should avoid opening an overlapping umbrella PR and should finish through coordination, follow-up issue creation, or a no-PR completion path instead.

### Undelegation And Re-delegation

Undelegation pauses PatchRelay authority. It does not erase PR truth.

- If there is no PR yet, the issue keeps its literal local-work state such as `delegated` or `implementing`, but PatchRelay becomes paused.
- If a PR already exists, the issue keeps its PR-backed state and PatchRelay becomes observer-only.
- Worktrees, branches, and PRs remain in place.
- PatchRelay still reflects GitHub review, CI, queue, merge, and close events while undelegated.
- PatchRelay does not enqueue implementation, review-fix, CI-repair, or queue-repair work again until the issue is delegated back.
- If someone opens a new PR for the issue while it is undelegated, PatchRelay can link that PR when the title, body, or branch name contains one unambiguous tracked issue key for the project.

Downstream services stay PR-centric:

- `review-quill` may still review a qualifying PR
- `merge-steward` may still queue or merge a qualifying PR

When the issue is delegated back to PatchRelay, it should resume from current truth:

- no PR: queue implementation
- PR with requested changes: queue review fix or branch upkeep
- PR with failing CI: queue CI repair
- PR with queue eviction/conflict: queue queue repair
- healthy open PR: keep waiting on review
- approved PR: keep waiting downstream

## Ownership Model

PatchRelay keeps ownership simple:

- workflow truth: the current factory state plus GitHub PR/review/CI facts
- runtime authority: whether PatchRelay may actively write or repair code right now

PatchRelay persists one explicit authority bit:

- `delegatedToPatchRelay`: whether PatchRelay may actively implement or repair code for the issue right now

Once a PR is linked to an issue, delegation decides whether PatchRelay may repair it. The PR may have been opened by PatchRelay, a human, or another external system.

That authority does not change just because:

- the issue is undelegated
- the PR becomes ready for review
- the PR is approved
- the PR enters or leaves the merge queue

## Factory State Machine

Each issue progresses through a factory state machine:

```text
delegated → preparing → implementing → pr_open → awaiting_review
  → changes_requested (review fix run) → back to implementing
  → repairing_ci (CI repair run) → back to pr_open
  → awaiting_queue → done (merged)
  → repairing_queue (queue repair run) → back to pr_open
  → escalated or failed (when retry budgets are exhausted)
```

Run types:

- `implementation` — initial coding work
- `review_fix` — address reviewer feedback
- `ci_repair` — fix failing CI checks
- `queue_repair` — fix merge queue failures

PatchRelay treats these as distinct loop types with different context, entry conditions, and success criteria rather than as one generic "ask the agent again" workflow.

The long-term runtime model is a small durable `IssueSession`:

- `idle`
- `running`
- `waiting_input`
- `done`
- `failed`

Waiting on review or queue should be represented as a waiting reason, not as a large internal control-plane state machine.

`awaiting_input` is reserved for real human-needed situations:

- a completion check asked a question
- an operator explicitly stopped the run and wants a next decision
- a reply is required before PatchRelay can continue

Undelegated local work should stay in its literal workflow state and show a paused waiting reason instead.

## Restart And Reconciliation

PatchRelay treats restart safety as part of the harness contract, not as a best-effort extra.

After a restart, the service can answer:

- which issue owns each active worktree
- which run was active or queued
- which Codex thread and turn belong to that work
- whether the issue is still eligible to continue
- whether the run should resume, hand off, or fail back to a human state

This is why PatchRelay keeps a durable `issues` and `runs` table alongside Codex thread history and Linear state. The goal is not to duplicate the model transcript. The goal is to make automation restartable, inspectable, and recoverable when the process or machine is interrupted.

## Workflow Files

PatchRelay uses repo-local workflow files as prompts for Codex runs:

- `IMPLEMENTATION_WORKFLOW.md` — used for implementation, CI repair, and queue repair runs
- `REVIEW_WORKFLOW.md` — used for review fix runs

These files define how the agent should work in that repository. Keep them short, action-oriented, and human-authored.

The built-in PatchRelay prompt scaffold lives in `src/prompting/patchrelay.ts`. It is intentionally small: task objective, scope discipline, reactive repair context, workflow guidance, and publication contract. Installation-level and repo-level prompt config can add one extra instructions file or replace a small set of policy sections. See [`docs/prompting.md`](./docs/prompting.md).

## Knowledge And Validation Surfaces

PatchRelay works best when repository guidance follows progressive disclosure:

- keep the root entrypoints short and navigational
- treat deeper `docs/` content as the durable system of record
- capture architecture, workflow, and product decisions in versioned files instead of chat history or operator memory

PatchRelay should also help agents validate their own work inside the issue loop:

- package the smallest useful context for the current run instead of replaying ever-growing transcript history
- preserve high-signal failure evidence such as review feedback, failing checks, and queue incidents
- make repo-local validation surfaces legible per worktree so the next run can see what passed, what failed, and what needs repair

Keeping those knowledge and validation surfaces clean is part of the harness, not optional documentation polish.

## Access Control

PatchRelay reacts only for issues that route to a configured project.

- use `linear_team_ids`, `issue_key_prefixes`, and optional labels to keep unrelated or public boards out of scope
- in the normal setup, anyone with access to the routed Linear project can delegate work to the PatchRelay app
- use `trusted_actors` only when a project needs a narrower allowlist inside Linear

That keeps the default model simple without forcing an extra allowlist for every team.

## Quick Start

### 1. Install

```bash
npm install -g patchrelay
```

### 2. Bootstrap config

```bash
patchrelay init https://patchrelay.example.com
```

`patchrelay init` requires the public HTTPS origin up front because Linear needs a fixed webhook URL and OAuth callback URL for this PatchRelay instance.

It creates the local config, env file, and system service units:

- `~/.config/patchrelay/runtime.env`
- `~/.config/patchrelay/service.env`
- `~/.config/patchrelay/patchrelay.json`
- `/etc/systemd/system/patchrelay.service`

The generated `patchrelay.json` is intentionally minimal, and `patchrelay init` prints the webhook URL, OAuth callback URL, and the Linear app values you need next.

### 3. Configure access

Edit `~/.config/patchrelay/service.env` and fill in only the Linear OAuth client values. Keep the generated webhook secret and token-encryption key:

```bash
LINEAR_WEBHOOK_SECRET=generated-by-patchrelay-init
PATCHRELAY_TOKEN_ENCRYPTION_KEY=generated-by-patchrelay-init
LINEAR_OAUTH_CLIENT_ID=replace-with-linear-oauth-client-id
LINEAR_OAUTH_CLIENT_SECRET=replace-with-linear-oauth-client-secret
```

Keep service secrets in `service.env`. `runtime.env` is for non-secret overrides such as `PATCHRELAY_DB_PATH` or `PATCHRELAY_LOG_FILE`. Everyday local inspection commands do not require exporting these values in your shell.

### 4. Connect PatchRelay to Linear

Connect PatchRelay to one Linear workspace:

```bash
patchrelay linear connect
patchrelay linear sync
```

This authorizes the workspace once, then caches its teams and projects locally. Workspace auth is separate from repo linking.

### 5. Link a GitHub repo

Link repos by GitHub identity, not by local path:

```bash
patchrelay repo link krasnoperov/usertold --workspace usertold --team USE
```

PatchRelay treats the GitHub repo as the source of truth. It reuses an existing local clone under the managed repo root when `origin` already matches, or clones it automatically when missing. Use `--path <path>` only when you want a non-default local location.

The generated `~/.config/patchrelay/patchrelay.json` stays machine-level service config. Repo links should be created with the CLI, not by hand-editing the file.

`patchrelay repo link` is idempotent:

- it creates or updates the linked repo entry
- it refreshes the selected Linear workspace catalog before resolving teams/projects
- it reloads the service when it can
- if workflow files or secrets are still missing, it tells you exactly what to fix and can be rerun safely

### 6. Add workflow docs to the repo

PatchRelay looks for:

```text
IMPLEMENTATION_WORKFLOW.md
REVIEW_WORKFLOW.md
```

These files define how the agent should work in that repo.

### 7. Validate

```bash
patchrelay doctor
patchrelay service status
patchrelay dashboard
```

### 8. Check linked workspaces and repos

```bash
patchrelay linear list
patchrelay repo list
```

If you later add another local repo from the same workspace, run `patchrelay repo link <owner/repo> --workspace <workspace> --team <team>` again. PatchRelay reuses the existing workspace installation instead of opening a new OAuth flow.

Important:

- Linear needs a public HTTPS URL to reach your webhook.
- `patchrelay init <public-base-url>` writes `server.public_base_url`, which PatchRelay uses when it prints webhook URLs.
- For ingress, OAuth app setup, and webhook details, use the self-hosting docs.

## Daily Loop

1. Delegate a Linear issue to the PatchRelay app.
2. Linear sends the delegation and agent-session webhooks to PatchRelay, which creates or reuses the issue worktree and launches an implementation run.
3. Follow up in the Linear agent session to steer the active run or wake it with fresh input while it remains delegated.
4. GitHub webhooks automatically trigger CI repair, review fix, or merge queue repair runs when needed.
5. Watch progress from the terminal or open the same worktree and take over manually.

Useful commands:

- `patchrelay dashboard`
- `patchrelay issue list --active`
- `patchrelay issue show APP-123`
- `patchrelay issue watch APP-123`
- `patchrelay issue path APP-123 --cd`
- `patchrelay issue open APP-123`
- `patchrelay issue retry APP-123`
- `patchrelay service restart`
- `patchrelay service logs --lines 100`

PatchRelay's operator surface is being reduced to its own runtime responsibilities: issue status,
active work, waiting reason, worktree handoff, and retry controls.

`patchrelay issue open` is the handoff bridge: it opens a normal Codex CLI session in the issue worktree and resumes the existing thread when PatchRelay has one.

If automation looks stuck, this is the usual operator path:

1. `patchrelay dashboard` to see active issues and waiting reasons across the service.
2. `patchrelay issue show APP-123` or `patchrelay issue watch APP-123` to inspect one issue in more detail.
3. `patchrelay issue open APP-123` to take over inside the exact worktree and continue from the same issue context.
4. `patchrelay service logs --lines 100` if the problem looks like webhook intake, Codex startup, or service runtime failure.

Today that takeover path is intentionally YOLO mode: it launches Codex with `--dangerously-bypass-approvals-and-sandbox`.

## Operator View

PatchRelay keeps enough durable state to answer the questions that matter during and after a run:

- which worktree and branch belong to an issue
- which run is active or queued
- which Codex thread owns the current work
- what the agent said
- which commands it ran
- which files it changed
- whether the run completed, failed, or needs handoff

## Downstream services

PatchRelay implements code and produces pull requests. Two separate services take those PRs the rest of the way. Both are independent, GitHub-native, and usable without PatchRelay.

### Review Quill

[review-quill](./packages/review-quill) watches PRs and posts ordinary GitHub reviews from a real local checkout of the PR head. By default it reviews as soon as the head updates; it can optionally wait for configured checks to go green first.

```bash
review-quill init https://review.example.com
review-quill repo attach owner/repo
review-quill doctor --repo repo
```

See [review-quill README](./packages/review-quill/README.md) for setup, GitHub App permissions, and the review context pipeline.

### Merge Steward

[merge-steward](./packages/merge-steward) is a serial merge queue with speculative integration: it rebases each approved PR onto the current `main`, runs CI on the integrated SHA, and fast-forwards `main` only when that tested result is green. On failure it evicts with a durable incident and a GitHub check run — the signal PatchRelay (or any agent) uses to trigger a repair.

```bash
merge-steward init https://queue.example.com
merge-steward attach owner/repo --base-branch main
merge-steward doctor --repo repo
merge-steward service status
merge-steward queue status --repo repo
```

See [Merge queue](./docs/merge-queue.md) for the full two-service overview and [merge-steward README](./packages/merge-steward/README.md) for operational details.

### Driving these with your own agent

If you want to use `review-quill` and `merge-steward` with your own agent (Claude Code, Cursor, Codex CLI, …) without running the PatchRelay harness itself, install the [`ship-pr`](https://github.com/krasnoperov/patchrelay-agents) skill from the companion marketplace. It teaches the agent to drive both services through their `pr status --wait` verbs and react to structured failure reasons. See [patchrelay-agents](https://github.com/krasnoperov/patchrelay-agents).

## Docs

Use the README for the product overview and quick start. Use the docs for operating details:

- [Merge queue and delivery](./docs/merge-queue.md)
- [Self-hosting and deployment](./docs/self-hosting.md)
- [Architecture](./docs/architecture.md)
- [Design docs index](./docs/design-docs/index.md)
- [Design principles](./docs/design-docs/core-beliefs.md)
- [External reference patterns](./docs/references/external-patterns.md)
- [Security policy](./SECURITY.md)

## Status

PatchRelay is usable now, but still early and opinionated. The focus is a strong self-hosted harness for Linear + Codex work, not a generalized SaaS control plane.
