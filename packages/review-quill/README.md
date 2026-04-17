# review-quill

`review-quill` is a self-hosted GitHub PR review bot. It watches configured
repositories, materializes the exact PR head SHA in a throwaway checkout,
builds the review context locally, runs a read-only Codex review pass, and
publishes a normal GitHub PR review with its GitHub App identity.

It fits alongside:

- `patchrelay` for delegated implementation and PR upkeep
- `merge-steward` for queue admission and merge execution

You can run `review-quill` on its own. PatchRelay is not required.

## What It Does

For each eligible PR head, `review-quill`:

1. detects that a new reviewable PR head exists
2. materializes an ephemeral local checkout of that exact SHA
3. builds a curated diff against the PR base branch
4. loads repo review guidance such as `REVIEW_WORKFLOW.md`, `CLAUDE.md`, and `AGENTS.md`
5. runs a review pass through `codex app-server`
6. publishes an ordinary GitHub `APPROVE` or `REQUEST_CHANGES` review
7. cancels stale in-flight attempts when a newer PR head lands first

This keeps review grounded in the real repository state instead of only the
GitHub files API.

By default, a PR becomes eligible for review as soon as its branch head
updates. If a repo needs the older behavior, set
`waitForGreenChecks: true` in that repo's `review-quill` config to wait for
configured checks to go green first.

## Quick Start

### 1. Install

```bash
npm install -g review-quill
```

### 2. Bootstrap the local home

```bash
review-quill init https://patchrelay.example.com/review
```

That creates:

- `~/.config/review-quill/runtime.env`
- `~/.config/review-quill/service.env`
- `~/.config/review-quill/review-quill.json`
- `/etc/systemd/system/review-quill.service`

### 3. Configure GitHub access

Quick-start path: put the non-secret GitHub App id in `service.env` and keep
the webhook secret plus App private key in encrypted systemd credentials.

Typical machine-level config:

```bash
REVIEW_QUILL_GITHUB_APP_ID=123456
REVIEW_QUILL_GITHUB_APP_INSTALLATION_ID=12345678
```

Recommended encrypted credentials:

- `review-quill-webhook-secret`
- `review-quill-github-app-pem`

For first-time local bring-up you can also use environment-file secrets, but
production should prefer encrypted systemd credentials.

### 4. Attach a repository

```bash
review-quill repo attach owner/repo
```

`review-quill repo attach` is the normal happy-path command:

- it adds or updates one watched repository
- it can auto-discover the default branch and required checks
- it starts reviews immediately after branch updates unless you opt into waiting for green checks
- it stores repo-local review doc paths
- it reloads the service when needed

If you want machine review to count toward merge admission, include
`review-quill/verdict` in the repository's required checks and in any downstream
merge queue policy.

### 5. Validate the install

```bash
review-quill doctor --repo repo
review-quill service status
review-quill dashboard
```

That is the minimum “is this actually alive?” loop.

## Public Ingress

Recommended public base URL:

- `https://patchrelay.example.com/review`

That gives these public endpoints:

- `POST /review/webhooks/github` for the GitHub App webhook
- `GET /review/health` for external health checks
- `GET /review/attempts/:id` for check-run detail links

Keep these local-only:

- `/review/watch`
- `/review/attempts`
- `/review/admin/*`

The package ships an example Caddy config at [infra/Caddyfile](./infra/Caddyfile).

## GitHub App Permissions

This is the current known-good permission set:

Repository permissions:

- `Contents: Read and write`
- `Issues: Read and write`
- `Pull requests: Read and write`
- `Actions: Read-only`
- `Metadata: Read-only`

Webhook events:

- `Pull request`
- `Check run`
- `Check suite`

Notes:

- `Pull requests: Read and write` is what lets `review-quill` submit ordinary GitHub reviews.
- `Actions: Read-only` lets it observe CI state clearly.
- `Contents: Read and write` is part of the validated working setup today.

## CLI Surface

The operator-facing commands are:

- `review-quill init <public-base-url>`
- `review-quill repo attach <owner/repo>`
- `review-quill repo list`
- `review-quill repo show <id>`
- `review-quill doctor --repo <id>`
- `review-quill service status`
- `review-quill service restart`
- `review-quill service logs --lines 100`
- `review-quill dashboard`
- `review-quill attempts [<repo>] [<pr-number>]` (accepts `--repo`/`--pr` flags, auto-resolves from git checkout)
- `review-quill transcript [<repo>] [<pr-number>]`
- `review-quill transcript-source [<repo>] [<pr-number>]`
- `review-quill pr status [--repo <id>] [--pr <num>] [--wait] [--timeout <s>] [--poll <s>] [--json]`
- `review-quill diff --repo <id>`

`watch` is kept as an alias for `dashboard`, but `dashboard` is the name to
document and use.

### Resolving --repo and --pr from the current checkout

`pr status`, `attempts`, `transcript`, and `transcript-source` accept `--repo` and `--pr` but you can omit them when running from inside a git checkout. `review-quill` reads `origin`'s remote URL, matches it to an attached repoId, and uses `gh pr view` to find the PR for the current branch. Pass `--cwd <path>` to resolve from a different directory.

### Exit codes (pr status)

| code | meaning |
|-|-|
| 0 | approved / skipped |
| 2 | declined (changes requested) / errored / cancelled |
| 3 | queued / running / no attempt yet |
| 4 | `--wait` timed out before a terminal state was reached |
| 1 | usage or configuration error |

## Validation, Visibility, And Troubleshooting

These are the key commands once the service is installed:

```bash
review-quill doctor --repo repo
review-quill service status
review-quill service restart
review-quill dashboard
review-quill attempts repo 123
review-quill transcript repo 123
review-quill pr status                # from a git checkout; resolves repo + PR automatically
review-quill diff --repo repo
review-quill service logs --lines 100
```

Use them this way:

- `doctor` checks config, binaries, service reachability, and GitHub review wiring.
- `dashboard` shows queued/running/completed review attempts and recent webhook wakeups.
- `pr status` returns a single agent-friendly verdict on one PR with a stable exit code; supports `--wait` to poll until a review attempt terminates.
- `attempts` shows recorded review history for one PR.
- `transcript` lets you inspect the visible Codex thread for a review attempt.
- `diff` shows the exact local diff/inventory the reviewer would see.
- `service logs` is where to look when webhooks are not arriving, Codex requests fail, or GitHub publishing fails.

If GitHub is not counting `review-quill` reviews toward branch protection:

1. verify the App permission set above
2. confirm the repository requires the review/check signals you expect
3. run `review-quill doctor --repo <id>`
4. inspect recent attempts and transcripts for the affected PR

## Review Context

`review-quill` reviews from a real checked-out PR head, not just GitHub API
metadata.

The default context path is:

- ephemeral local checkout at the exact PR head SHA
- local `git diff <base>...HEAD` inventory and curated patch set
- repo guidance from `REVIEW_WORKFLOW.md`, `CLAUDE.md`, and `AGENTS.md`
- prior formal PR reviews from GitHub
- optional Linear issue context when issue keys appear in the PR metadata

The built-in review scaffold lives in `packages/review-quill/src/prompt-builder/render.ts`. It keeps the always-on reviewer prompt small: output contract, review rules, PR metadata, diff, repo guidance, and prior review claims. Install-level and repo-level prompt config can add one extra instructions file or replace the review-rubric section. See [`docs/prompting.md`](../../docs/prompting.md).

Diff context is intentionally filtered:

- noisy/generated paths can be ignored or summarized
- oversized patches are summarized instead of dumped whole
- repo config can tune ignore/summarize patterns and patch budgets

## Relationship To PatchRelay And Merge Steward

The three services have distinct ownership:

- `patchrelay` owns implementation, branch upkeep, and issue/worktree orchestration
- `review-quill` owns PR review publication
- `merge-steward` owns queue admission, speculative validation, and landing

GitHub is the shared protocol boundary between them.

## Happy Path

```bash
review-quill init https://patchrelay.example.com/review
review-quill repo attach owner/repo
review-quill doctor --repo repo
review-quill service status
review-quill dashboard
```
