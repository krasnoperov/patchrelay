# PR delivery pipeline

Three independent services handle the path from "PR exists" to "merged on `main`":

- **patchrelay** develops code and produces pull requests. Owns issue worktrees, agent runs (implementation, review fix, CI repair), and Linear session UX.
- **review-quill** reviews every merge-ready head and publishes an ordinary GitHub `APPROVE` or `REQUEST_CHANGES` review.
- **merge-steward** admits approved, green PRs into a serial merge queue, speculatively integrates each one on top of the current `main`, validates, and fast-forwards.

Neither downstream service calls the other's API, and neither calls patchrelay. GitHub is the shared bus — PR state, reviews, checks, and branch changes are the protocol. Each service is independently usable; a repo can adopt any subset.

For the concrete shared artifacts and ownership boundaries, see [github-queue-contract.md](./github-queue-contract.md).

## Why split the pipeline

The merge queue is a deterministic control problem that should keep making progress even when agent execution is unavailable, degraded, or expensive.

Observed behavior showed patchrelay spent far more work on orchestration churn (173/232 runs in an early batch) than on real code repair. Splitting the queue from the agent harness:

- keeps the model where it helps (issue implementation and repair)
- removes it from the part that most needs simple, restart-safe, auditable control (queue advancement)
- allows the steward to be a pure reconciliation loop

PR review was split out for the same reason: it has its own decision surface (approve/decline), its own failure mode (stale reviews on an old head), and its own natural frequency. Running it as a dedicated service keeps each loop simple.

See the design docs for the full analysis: [design-docs/merge-steward.md](./design-docs/merge-steward.md), [design-docs/review-quill.md](./design-docs/review-quill.md).

## Lifecycle

```text
PR opened (by patchrelay or a human)
  → review-quill reviews each new merge-ready head
  → when GitHub shows approved + required checks green, merge-steward admits
  → steward rebases onto main, runs CI on the integrated SHA
  → if green and main hasn't moved, fast-forward main; otherwise retry
  → on failure: retry (gated on base SHA change), then evict with a
    GitHub check run
  → patchrelay, ship-pr, or a human fixes the branch and pushes a new head
  → cycle repeats
```

Steward state machine:

```text
queued → preparing_head → validating → merging → merged
                                              → evicted (on failure after retries)
```

## Failure and repair handoff

When the queue head fails, the steward classifies the failure before acting:

- **Flaky / infra** — retry CI without agent repair
- **Branch-local** — evict and report via `merge-steward/queue` check run
- **Integration conflict** — evict and report via check run

On eviction, the steward creates a durable incident record and a GitHub check run with failure details. Any agent with access to the branch sees the check run failure and can repair:

- **patchrelay** sees the check run, triggers a `queue_repair` run, fixes the branch, pushes a new head.
- **[ship-pr](https://github.com/krasnoperov/patchrelay-agents) skill** (supervised mode) — an agent running in Claude Code / Cursor / Codex CLI interprets `merge-steward pr status --wait` exit-2 `evicted`, reads `merge-steward queue show --pr <num>` for the incident, fixes the branch, pushes.
- **Human** — reads the check run output and rebases manually.

In all three cases, the steward re-admits the PR from fresh GitHub truth once CI is green again.

```text
Steward evicts PR → creates check run with failure context
Agent (patchrelay | ship-pr | human) → fixes the branch → pushes a fresh head
Steward → re-admits from fresh GitHub truth
```

## Repository settings

### Allow auto-merge

Enable in Settings → General.

### Branch protection rules

Configure branch protection on the base branch (e.g., `main`):

| Setting | Value |
|-|-|
| Require a pull request before merging | Enabled |
| Require approvals | 1 (or more) |
| Require status checks to pass before merging | Enabled |
| Status checks that are required | Your CI job name (e.g., `test`) |
| Require branches to be up to date before merging | **Enabled** |
| Dismiss stale pull request approvals when new commits are pushed | **Disabled** |
| Require approval of the most recent reviewable push | **Disabled** |

**Why "Dismiss stale approvals" must be disabled:** the steward rebases and pushes the branch — that must not invalidate the existing approval.

**Why "Require approval of the most recent reviewable push" must be disabled:** the steward's rebase push is a mechanical branch update, not a reviewable change.

If you want machine review to count toward merge admission, include `review-quill/verdict` in the required checks.

### GitHub webhooks

Each service has its own GitHub webhook:

- **patchrelay** — its own GitHub webhook for PR, review, and check events that drive reactive repair loops. Events: Push, Pull request, Pull request review, Check suite, Check run.
- **review-quill** — its own GitHub App webhook. Events: Pull request, Check run, Check suite.
- **merge-steward** — its own GitHub App webhook. Events: Pull requests, Pull request reviews, Check suites, Pushes, Branch protection rules, Repository rulesets.

See each service's operator reference for the specific App permission set and webhook URL.

## Setup

Each service bootstraps independently:

```bash
# patchrelay (the harness)
patchrelay init https://patchrelay.example.com

# review-quill (PR review)
review-quill init https://review.example.com
review-quill repo attach owner/repo

# merge-steward (the queue)
merge-steward init https://queue.example.com
merge-steward attach owner/repo
```

For service-specific configuration, see:

- [docs/review-quill.md](./review-quill.md) — operator reference
- [docs/merge-steward.md](./merge-steward.md) — operator reference
- [docs/self-hosting.md](./self-hosting.md) — patchrelay install and ingress

## Read more

- [github-queue-contract.md](./github-queue-contract.md) — shared GitHub artifacts
- [merge-queue-runbook.md](./merge-queue-runbook.md) — happy path, conflicts, failures, repair handoff
- [design-docs/merge-steward.md](./design-docs/merge-steward.md) — why the split, phased roadmap, repair contract
- [design-docs/review-quill.md](./design-docs/review-quill.md) — review service design rationale
