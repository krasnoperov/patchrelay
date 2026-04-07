# Review Quill

## Purpose

`review-quill` is the dedicated PR review service for the PatchRelay stack.

It exists to answer one narrow question reliably:

- for the latest head SHA of an open, non-draft PR with green required CI, should this PR be approved or declined?

This service is intentionally separate from both:

- `patchrelay`, which owns delegated implementation work and upkeep of PatchRelay-authored branches
- `merge-steward`, which owns merge admission, queue ordering, and final landing

## Why This Should Be A Service, Not Workflow Sprawl

Review automation looks simple at first, but the real contract is not "run on one GitHub event."

The real contract is:

- PR is still open
- PR is still non-draft
- the reviewed SHA is still the current head SHA
- required CI is green for that exact SHA
- no fresh `review-quill` verdict already exists for that SHA

No single GitHub Actions trigger expresses that contract cleanly.

GitHub Actions are still useful for CI, but review orchestration benefits from:

- persistent state
- webhook intake
- deduplication
- idempotent retries
- periodic reconciliation
- a stable GitHub App identity

That is the same reason `merge-steward` exists as a separate service instead of queue behavior being encoded in workflow YAML.

## Core Decision

`review-quill` should be implemented as a GitHub-first service with:

- a dedicated GitHub App identity
- webhook-driven wakeups
- periodic reconciliation
- one review attempt per `(repo, pr_number, head_sha)`
- `codex app-server` as the review execution runtime

The service should publish both:

- a GitHub PR review for humans
- a GitHub check run for deterministic branch protection

## Responsibility Split

| System | Owns |
|-|-|
| PatchRelay | delegated implementation, branch-local repair, PatchRelay-authored PR upkeep |
| Review Quill | review eligibility, review execution, verdict publication, review reconciliation |
| Merge Steward | merge gate admission, queue lifecycle, merge execution |
| GitHub | PR truth, review truth, status-check truth, branch protection |

## Eligibility Rule

`review-quill` should review a PR only when all are true:

1. the PR is open
2. the PR is ready for review, not draft
3. the current `headSha` is known
4. required CI is settled green for that exact `headSha`
5. no valid `review-quill` verdict already exists for that exact `headSha`

Review readiness must always be recomputed from fresh GitHub truth.

The service should not rely on:

- labels like `needs-review`
- manual queue labels
- a stored state machine as the authoritative source
- a single webhook meaning "now review"

## Trigger Model

### Webhooks Are Wakeups, Not Truth

Useful wake sources include:

- `pull_request.opened`
- `pull_request.reopened`
- `pull_request.ready_for_review`
- `pull_request.synchronize`
- `check_suite`
- `check_run`
- `pull_request_review` dismissal or stale-approval events when available

These events only wake the system.
They must not directly imply review eligibility.

### Reconciliation Is Required

`review-quill` should run a periodic reconciler.

Recommended starting interval:

- every 2 to 5 minutes

The reconciler should:

- scan configured repositories for open PRs
- re-evaluate eligibility
- backfill missed webhook deliveries
- recover from crashes or transient GitHub/API failures

If the product promise is "your PRs eventually get reviewed," reconciliation is part of the contract.

## Identity And GitHub Authentication

`review-quill` should use a dedicated GitHub App.

Reasons:

- fine-grained repository permissions
- short-lived installation tokens
- centralized webhooks
- stable bot identity
- app-native check run support
- better auditability than `github-actions[bot]`

The GitHub App should be the actor for:

- listing and reading PR state
- publishing review comments
- publishing `APPROVE` or `REQUEST_CHANGES`
- creating and updating the `review-quill/verdict` check run

### Known-Good GitHub App Permissions

This is the currently validated permission set for `review-quill`. After moving
the app to this shape, GitHub started counting `review-quill` approvals toward
the normal branch review gate.

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

This is a known-good set, not a proven minimal set.

### `gh` / `git` Identity

Like PatchRelay, `review-quill` should override `gh` and `git` credentials with the current installation token when running review jobs.

That gives:

- consistent bot authorship
- repo-scoped permissions
- no dependency on a human PAT

Unlike PatchRelay, `review-quill` should not normally push commits.
Git setup exists mainly so readonly checkout, diff inspection, and any local helper commands run under the service identity.

## Runtime Model

This service should be much simpler than PatchRelay.

### Stable Record

The durable identity is:

- repository
- PR number
- head SHA

Not:

- a long-lived issue session
- a reusable implementation thread
- a mutable branch worktree

### Execution Shape

Each review attempt should be:

- fresh
- readonly
- keyed to one head SHA
- idempotent
- cancelled or superseded at publish time if GitHub truth changed underneath it

Recommended model:

- one ephemeral workspace per attempt
- one fresh `codex app-server` thread
- one review turn
- optional retry if the app-server call fails before producing a verdict

Do not use PatchRelay-style long-lived thread steering for review attempts.

## Check Run Contract

The authoritative machine-facing gate should be a GitHub check run:

- `review-quill/verdict`

Possible conclusions:

- `success` — approved
- `failure` — declined
- `neutral` — skipped by policy
- `cancelled` — superseded by a newer head SHA

The check run should always be keyed to the reviewed `headSha`.

Branch protection should require:

- CI gate(s)
- `review-quill/verdict`

The PR review is the human-facing representation.
The check run is the merge-gate representation.

In practice, `merge-steward` uses GitHub PR review truth plus configured
required checks for admission, and then validates speculative integrated
branches itself before landing. So `review-quill/verdict` is optional unless a
repository explicitly chooses to make it part of its required checks.

## PR Review Contract

For an eligible PR head, `review-quill` should publish one of:

- `APPROVE`
- `REQUEST_CHANGES`

Review output should include:

- a short verdict summary
- blocking findings with file and line references when relevant
- non-blocking nits separated from blocking issues

If a newer head SHA appears before publication:

- cancel the old attempt
- avoid publishing a stale review
- publish `cancelled` or `neutral` on the old check if needed

Operator surfaces should make this visible:

- watch/dashboard should show `cancelled` and `superseded` attempts
- attempt detail should preserve the supersession reason
- doctor should warn when GitHub is not actually counting recent approvals

## Prompt And Repo Guidance

The review prompt should be built from a prepared review-context pipeline, not
directly inside the runner.

### Review Workspace

Each attempt should materialize an ephemeral local checkout:

- fetch base branch plus `refs/pull/<pr>/head`
- create a detached temp worktree at the exact PR head SHA
- run `codex app-server` inside that checkout
- dispose the worktree after publication

### Diff Context

Build diff context locally from the checked-out repo:

- `git diff <base>...HEAD` file inventory
- per-file patch extraction for reviewable files
- summarized entries for noisy/generated/oversized files

The initial default summarize-only set should include common lockfiles and
generated outputs such as:

- `package-lock.json`
- `pnpm-lock.yaml`
- `yarn.lock`
- `bun.lock*`
- `dist/**`
- `build/**`
- `coverage/**`
- `*.map`
- `*.min.js`
- `*.snap`

### Prompt Context

Prompt context should include:

- PR title and body
- current head SHA
- base branch
- prior formal PR reviews
- explicit repo-local guidance docs:
  - `REVIEW_WORKFLOW.md`
  - `CLAUDE.md`
  - `AGENTS.md`

`AGENTS.md` should still be loaded explicitly for safety, even though
`app-server` also sees it from the checked-out repo cwd.

The prompt must explicitly say:

- GitHub truth is authoritative
- review only the current head SHA
- approve only if the current diff is acceptable as merged
- stale context must not override fresh GitHub state

## Minimal Data Model

Suggested starting tables:

- `webhook_events`
  - delivery id
  - event type
  - received at
  - processed status

- `pull_requests`
  - repo id
  - repo full name
  - PR number
  - latest observed head SHA
  - open/draft state
  - latest known review-quill status
  - last reconciled at

- `review_attempts`
  - repo id
  - PR number
  - head SHA
  - status (`queued`, `running`, `completed`, `failed`, `cancelled`, `superseded`)
  - conclusion (`approved`, `declined`, `skipped`)
  - thread id
  - started at / completed at
  - summary json

- `check_runs`
  - repo id
  - PR number
  - head SHA
  - external check-run id
  - lifecycle state

- `review_events`
  - append-only audit/history table for operator visibility

## Deduplication And Leasing

GitHub webhooks are duplicated and may arrive out of order.

`review-quill` should:

- dedupe deliveries by delivery id when available
- dedupe review attempts by `(repo, pr_number, head_sha)`
- use short leases so only one worker can review the same head SHA at once

Every side-effecting publication should verify that:

- the review attempt still owns the lease
- the PR still points at the same `headSha`

## Secrets And Config

Follow the same secret resolution model as PatchRelay:

1. `$CREDENTIALS_DIRECTORY/<name>`
2. `${ENV_KEY}_FILE`
3. `${ENV_KEY}`

Recommended config layout:

- `~/.config/review-quill/runtime.env`
- `~/.config/review-quill/service.env`
- `~/.config/review-quill/review-quill.json`
- `/etc/systemd/system/review-quill.service`

Suggested public ingress for the shared PatchRelay host:

- base URL: `https://patchrelay.example.com/review`
- webhook URL: `https://patchrelay.example.com/review/webhooks/github`
- attempt detail URL: `https://patchrelay.example.com/review/attempts/:id`

Recommended encrypted credentials:

- `review-quill-webhook-secret`
- `review-quill-github-app-pem`
- optional model/runtime credentials when not supplied by local operator auth

Suggested non-secret env/config keys:

- `REVIEW_QUILL_PUBLIC_BASE_URL`
- `REVIEW_QUILL_CONFIG_DIR`
- `REVIEW_QUILL_STATE_DIR`
- `REVIEW_QUILL_DATA_DIR`
- `REVIEW_QUILL_DB_PATH`
- `REVIEW_QUILL_BIND`
- `REVIEW_QUILL_PORT`
- `REVIEW_QUILL_GITHUB_APP_ID`
- `REVIEW_QUILL_GITHUB_APP_INSTALLATION_ID`
- `REVIEW_QUILL_MODEL`
- `REVIEW_QUILL_CODEX_BASE_URL`

## `codex app-server` Execution Model

`review-quill` should use `codex app-server`, but in a smaller runtime shape than PatchRelay.

Recommended starting point:

- one app-server turn per review attempt
- no long-lived review threads
- no turn steering across multiple webhook events
- no branch mutation tools

Allowed tools for the review turn should stay narrow:

- read git diff / changed files
- read selected repo docs
- query GitHub PR metadata and previous reviews
- publish the final review only through the service, not directly from the model

The model should return a structured verdict to the service.
The service should remain the sole publisher of:

- PR reviews
- inline comments
- check runs

That keeps publication idempotent and easier to reconcile.

## Out Of Scope For V1

- direct code fixes
- auto-commit or push
- merge queue ownership
- cross-repo review batching
- stack-aware review semantics
- human assignment and reviewer-routing workflows

Those may come later, but V1 should stay tightly focused on "review the latest merge-ready head reliably."

## Suggested V1 Milestones

1. Package scaffold and config model
2. GitHub App auth and webhook intake
3. PR eligibility reconciler
4. `review-quill/verdict` check run publication
5. one-shot app-server review execution
6. PR review publication
7. dedupe, lease fencing, and restart recovery

## Naming Contract

The service name is:

- `review-quill`

Canonical surfaces:

- package: `packages/review-quill`
- binary: `review-quill`
- config dir: `~/.config/review-quill`
- systemd unit: `review-quill.service`
- check run: `review-quill/verdict`
