# Merge Queue

PatchRelay and Merge Steward are two independent services with distinct responsibilities:

- **PatchRelay** develops code and delivers pull requests — it owns issue worktrees, agent runs (implementation, review fix, CI repair), and Linear session UX
- **Merge Steward** delivers pull requests into production — it owns queue ordering, branch freshness, CI validation, merge decisions, and retry/eviction policy

Neither service calls the other's API. GitHub is the shared bus — labels, check runs, and PR state changes are the protocol.

See [GitHub queue contract](./github-queue-contract.md) for the concrete shared artifacts and ownership boundaries.

## Why Two Services

The merge queue is a deterministic control problem that should keep making progress even when agent execution is unavailable, degraded, or expensive.

Observed behavior showed PatchRelay spent far more work on orchestration churn (173/232 runs in an early batch) than on real code repair. Splitting the queue from the agent harness:

- keeps the model where it helps (issue implementation and repair)
- removes it from the part that most needs simple, restart-safe, auditable control (queue advancement)
- allows the steward to be a pure reconciliation loop

See [design rationale](./design-docs/merge-steward.md) for the full analysis.

## Queue Lifecycle

1. A PR gets the `queue` label (added by PatchRelay when an issue reaches `awaiting_queue`, or manually by any automation)
2. The steward sees the label via GitHub webhook
3. If the PR is approved and CI is green, it enters the queue
4. The steward processes the queue head: fetch → rebase onto main → push → wait for CI → merge
5. Non-head entries remain frozen until the queue advances — no wasted CI runs
6. After the head merges, the steward advances to the next entry

```text
queued → preparing_head → validating → merging → merged
                                              → evicted (on failure after retries)
```

## Failure And Repair Handoff

When the queue head fails, the steward classifies the failure before acting:

- **Flaky / infra** — retry CI without agent repair
- **Branch-local** — evict and report via `merge-steward/queue` check run
- **Integration conflict** — evict and report via check run

On eviction, the steward creates a durable incident record and a GitHub check run with failure details. PatchRelay (or any agent) sees the check run failure, triggers a `queue_repair` run, fixes the branch, and re-adds the `queue` label. The steward re-admits the PR.

```text
Steward evicts PR → creates check run with failure context
PatchRelay sees check run failure → triggers queue_repair run
Agent fixes the branch → PatchRelay re-adds queue label
Steward re-admits the PR
```

## Repository Settings

### Allow Auto-Merge

Enable in Settings → General.

### Branch Protection Rules

Configure branch protection on your base branch (e.g., `main`):

| Setting | Value |
|-|-|
| Require a pull request before merging | Enabled |
| Require approvals | 1 (or more) |
| Require status checks to pass before merging | Enabled |
| Status checks that are required | Your CI job name (e.g., `test`) |
| Require branches to be up to date before merging | **Enabled** |
| Dismiss stale pull request approvals when new commits are pushed | **Disabled** |
| Require approval of the most recent reviewable push | **Disabled** |

**Why "Dismiss stale approvals" must be disabled:** The steward rebases and pushes the branch — that must not invalidate the existing approval.

**Why "Require approval of the most recent reviewable push" must be disabled:** The steward's rebase push is a mechanical branch update, not a reviewable change.

### GitHub Webhook

Configure a webhook on the repository pointing to the steward:

- **Payload URL:** `https://queue.example.com/webhooks/github`
- **Content type:** `application/json`
- **Secret:** same as `MERGE_STEWARD_WEBHOOK_SECRET` or the `merge-steward-webhook-secret` systemd credential
- **Events:** Pull requests, Pull request reviews, Check suites, Pushes

Merge Steward now uses one unified multi-repo webhook endpoint and routes by `repository.full_name`.

Set the steward config and secrets like this:

- machine-level non-secret config: `~/.config/merge-steward/service.env`
- production/systemd secrets: provide `/etc/credstore.encrypted/merge-steward-webhook-secret.cred` and `/etc/credstore.encrypted/merge-steward-github-app-pem.cred`; the service unit loads them directly

Typical local `service.env`:

```bash
MERGE_STEWARD_GITHUB_APP_ID=123456
MERGE_STEWARD_GITHUB_APP_INSTALLATION_ID=12345678
```

GitHub App auth is the production path. Merge Steward mints short-lived installation tokens from the service-owned app private key and uses them for PR reads, check reads, queue eviction check runs, label removal, merges, and HTTPS git operations. The CLI talks to the local service for GitHub-backed discovery and doctor checks instead of reading secret credentials itself.

PatchRelay needs its own separate GitHub webhook for PR, review, and check events that drive reactive repair loops.

### GitHub App Events (PatchRelay)

If using a GitHub App for PatchRelay, subscribe to these events:

| Event | Required for |
|-|-|
| Push | Detecting base branch updates |
| Pull request | PR opened/closed/merged state tracking |
| Pull request review | Approval and change-request detection |
| Check suite | CI pass/fail state transitions |
| Check run | Steward eviction detection (triggers queue repair) |

## Running Merge Steward

The happy-path bootstrap is:

```bash
merge-steward init https://queue.example.com
merge-steward attach owner/repo
merge-steward doctor --repo repo
merge-steward service status
merge-steward queue status --repo repo
```

`attach` now discovers the GitHub default branch and required status checks automatically when GitHub App auth is configured, then stores those values into local repo config. `doctor --repo <id>` compares the stored values to GitHub and warns if base branch or required checks drift.

See [packages/merge-steward/README.md](../packages/merge-steward/README.md) for configuration, API reference, watch TUI, and systemd setup.

## Read More

- [Merge Steward README](../packages/merge-steward/README.md) — operational docs
- [Merge queue runbook](./merge-queue-runbook.md) — happy path, conflicts, failures, repair handoff, and operator surfaces
- [Merge Steward design rationale](./design-docs/merge-steward.md) — why the split, phased roadmap, repair contract
