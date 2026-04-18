# merge-steward operator reference

Full setup, configuration, and troubleshooting reference for `merge-steward`. For the high-level pitch, see the [package README](../packages/merge-steward/README.md). For the two-service overview, see [merge-queue.md](./merge-queue.md). For design rationale, see [design-docs/merge-steward.md](./design-docs/merge-steward.md).

## Prerequisites

- Node.js 24+
- `gh` CLI in `PATH`
- `git` binary

## Install and bootstrap

```bash
npm install -g merge-steward
merge-steward init https://queue.example.com
```

`init` creates:

- `~/.config/merge-steward/runtime.env`
- `~/.config/merge-steward/service.env`
- `~/.config/merge-steward/merge-steward.json`
- `~/.config/merge-steward/repos/`
- `/etc/systemd/system/merge-steward.service`

## Attach a repository

```bash
merge-steward attach owner/repo
```

`attach` writes `~/.config/merge-steward/repos/<derived-id>.json`. The steward:

- derives the `repoId` from the GitHub repo name
- discovers the default branch from GitHub
- learns required checks from GitHub branch protection at runtime (no local copy)

Pass `--refresh` to re-discover the base branch for an existing repo config. `merge-steward doctor --repo <id>` reports the currently-enforced GitHub-required checks for the branch.

### Repo config fields

The file `attach` writes looks like:

```json
{
  "repoId": "app",
  "repoFullName": "owner/repo",
  "baseBranch": "main",
  "clonePath": "~/.local/state/merge-steward/repos/app",
  "maxRetries": 2,
  "flakyRetries": 1,
  "pollIntervalMs": 30000,
  "admissionLabel": "queue",
  "mergeQueueCheckName": "merge-steward/queue",
  "server": { "bind": "127.0.0.1", "port": 8790 },
  "database": { "path": "~/.local/state/merge-steward/app.sqlite" }
}
```

| Field | Description |
|-|-|
| `repoId` | Internal ID for this repo (used in DB keys) |
| `repoFullName` | GitHub `owner/repo` |
| `baseBranch` | Target branch for merges (usually `main`) |
| `clonePath` | Local clone directory (created on first run) |
| `maxRetries` | Rebase/CI retry attempts before eviction |
| `flakyRetries` | CI-only retries, separate from `maxRetries` |
| `pollIntervalMs` | Reconciliation loop interval |
| `admissionLabel` | Optional GitHub label used as a manual admission nudge |
| `mergeQueueCheckName` | Name of the check run emitted on eviction |

## GitHub App configuration

Required **repository permissions**:

| Permission | Access | Why |
|-|-|-|
| Contents | Read and write | Fast-forward `main` to tested speculative SHAs |
| Pull requests | Read and write | |
| Checks | Read and write | Emit eviction check runs |
| Metadata | Read-only | |
| Administration | Read-only | Discover branch rules and required checks without a user token |

`Administration: Read-only` is not required for merging itself — it lets the doctor and attach/refresh flows learn branch protection policy.

When GitHub App auth is configured, the steward mints short-lived installation tokens and uses them for both `gh` API calls and `git clone/fetch/push` over HTTPS. In multi-repo setups it resolves the installation per repo, so repos in different GitHub App installations coexist.

## Secrets

Keep only non-secret identifiers in `~/.config/merge-steward/service.env`:

```bash
MERGE_STEWARD_GITHUB_APP_ID=123456
MERGE_STEWARD_GITHUB_APP_INSTALLATION_ID=12345678
```

Store secrets in encrypted systemd credentials:

- `/etc/credstore.encrypted/merge-steward-webhook-secret.cred`
- `/etc/credstore.encrypted/merge-steward-github-app-pem.cred`

Webhook-secret resolution order at runtime:

1. `$CREDENTIALS_DIRECTORY/<name>`
2. `${ENV_KEY}_FILE`
3. `${ENV_KEY}`

See [secrets.md](./secrets.md) for the stack-wide convention.

## GitHub webhook

Configure one webhook per repository pointing to the steward:

- **Payload URL**: `https://queue.example.com/webhooks/github`
- **Content type**: `application/json`
- **Secret**: same as `MERGE_STEWARD_WEBHOOK_SECRET` or the encrypted credential
- **Events**: Pull requests, Pull request reviews, Check suites, Pushes, Branch protection rules, Repository rulesets

The steward uses a single multi-repo webhook endpoint and routes events by `repository.full_name`. It wakes on:

- PR label changes
- review approvals
- successful check-suite completion
- pushes to the base branch
- branch protection edits
- repository ruleset edits

On startup, the steward reconciles GitHub branch protection for every attached repo. Policy changes are normally learned from GitHub policy webhooks. If a merge is rejected unexpectedly, the steward performs a guarded one-shot policy refresh to recover from a missed webhook without polling GitHub continuously.

## CLI surface

| Command | Purpose |
|-|-|
| `merge-steward init <public-base-url>` | Bootstrap the local home |
| `merge-steward attach <owner/repo>` | Create or update a repo config, restart the service |
| `merge-steward repo list` / `repo show <id>` | Inspect attached repos |
| `merge-steward doctor --repo <id>` | Validate config, auth, branch rules, required checks |
| `merge-steward service status` / `restart` / `logs` | Service controls |
| `merge-steward dashboard [--repo <id>] [--pr <num>]` | Operator UI across all configured projects |
| `merge-steward queue status [--repo <id>]` | Queue summary and current entries |
| `merge-steward queue show --pr <num>` | One entry with events and incidents |
| `merge-steward queue reconcile --repo <id>` | Trigger one reconcile tick immediately |
| `merge-steward pr status [--wait --timeout S --poll S]` | Single-PR verdict with stable exit code |
| `merge-steward serve` | Manual foreground run (all attached repos) |

### Resolving `--repo` and `--pr` from the current checkout

`pr status`, `queue status`, `queue show`, and `queue reconcile` accept explicit flags but auto-resolve when run inside a git checkout. The steward reads `origin`'s remote URL, matches it to an attached `repoId`, and uses `gh pr view` to find the PR for the current branch. Pass `--cwd <path>` to resolve from a different directory.

### Exit codes for `pr status`

| Code | Meaning |
|-|-|
| 0 | merged / approved with green required checks |
| 2 | changes_requested / failing required checks / evicted / closed |
| 3 | still in flight (queued, preparing, validating, merging, pending) |
| 4 | `--wait` timed out before a terminal state |
| 1 | usage or configuration error |

## Queue state machine

```
queued → preparing_head → validating → merging → merged
                                              → evicted (on failure after retries)
```

| State | Meaning |
|-|-|
| `queued` | Waiting in line |
| `preparing_head` | Fetching + rebasing onto base branch |
| `validating` | CI running on the speculative SHA |
| `merging` | Revalidation + merge |
| `merged` | Done |
| `evicted` | Failed after retry budget; incident created |
| `dequeued` | Manually removed |

## Merge gate

The real gate is:

- GitHub says the PR review state is approved
- configured required checks are green
- the steward's speculative integrated branch passes CI

`review-quill/verdict` only matters if you choose to include it in the repo's required checks.

GitHub branch protection is still useful as defense in depth, but the steward does not merge by pressing GitHub's merge button — it fast-forwards `main` to the already-tested speculative SHA. Successful queue merges therefore depend on the steward App being allowed to push that result to the protected branch.

## HTTP API

| Endpoint | Method | Description |
|-|-|-|
| `/health` | GET | Liveness check |
| `/repos/:repoId/queue/status` | GET | All queue entries for one repo |
| `/repos/:repoId/queue/watch` | GET | Snapshot used by the dashboard |
| `/repos/:repoId/queue/enqueue` | POST | Manually enqueue a PR |
| `/repos/:repoId/queue/reconcile` | POST | Trigger one reconcile tick |
| `/repos/:repoId/queue/entries/:id/detail` | GET | Entry detail with recent events and incidents |
| `/repos/:repoId/queue/entries/:id/dequeue` | POST | Remove from queue (non-destructive) |
| `/repos/:repoId/queue/entries/:id/update-head` | POST | Update head SHA (force-push) |
| `/repos/:repoId/queue/incidents/:id` | GET | Get incident details |
| `/repos/:repoId/queue/entries/:id/incidents` | GET | List incidents for an entry |
| `/webhooks/github` | POST | GitHub webhook receiver for all configured repos |

## Dashboard

`merge-steward dashboard` is the primary operator surface. The overview screen shows all configured projects with project-level queue health, readable stats, and a compact queue chain. Press `Enter` on a project for the detail view (queue entries, recent events, incidents for evicted PRs, live GitHub-required checks).

Controls: `j`/`k` or arrows move selection; `Enter` opens; `Esc` returns; `a` toggles active-vs-all in project view; `r` reconciles; `d` dequeues; `q` quits.

Use `--repo <id>` to open the project detail view directly, `--pr <num>` to preselect a PR.

## Interaction with PatchRelay

The steward and PatchRelay are independent services that communicate only through GitHub:

1. PatchRelay adds the `queue` label when an issue reaches `awaiting_queue`.
2. The steward merges the PR, or evicts it and creates the configured eviction check run (default `merge-steward/queue`).
3. PatchRelay watches for that check run failure and triggers `queue_repair`.
4. After repair, PatchRelay re-adds the `queue` label.
5. The steward re-admits the PR.

Neither service calls the other's API. See [merge-queue.md](./merge-queue.md) for the contract.

## systemd

```ini
[Unit]
Description=merge-steward
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=-/home/your-user/.config/merge-steward/runtime.env
EnvironmentFile=-/home/your-user/.config/merge-steward/service.env
LoadCredentialEncrypted=merge-steward-webhook-secret:/etc/credstore.encrypted/merge-steward-webhook-secret.cred
LoadCredentialEncrypted=merge-steward-github-app-pem:/etc/credstore.encrypted/merge-steward-github-app-pem.cred
ExecStart=/usr/bin/env merge-steward serve
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

## Troubleshooting

The gateway binds its HTTP port before repo initialization finishes. Each repo initializes independently in the background, so a bad clone or GitHub discovery problem stays local to that repo instead of taking down the whole dashboard.

| Symptom | First command |
|-|-|
| Is the service alive? | `merge-steward service status` |
| What is the queue doing right now? | `merge-steward dashboard` (or `queue status --repo <id>` in a shell) |
| Why is this PR stuck? | `merge-steward pr status` inside its checkout, then `queue show --pr <num>` |
| Eviction happened — why? | `merge-steward queue show --pr <num>` (events + incidents) |
| Queue looks frozen, no webhook activity | `merge-steward service logs --lines 100` |
| Required checks not enforced as expected | `merge-steward doctor --repo <id>` reports current GitHub policy |

## Current scope

Implemented:

- Speculative execution: cumulative branches (`main+A`, `main+A+B`, `main+A+B+C`) tested in parallel. Configurable depth (default 10, set `speculativeDepth: 1` for serial mode).
- Speculative consistency: when head merges, downstream entries that already passed do not re-test.
- Cascade invalidation: when a mid-chain entry fails, downstream speculative branches are rebuilt without it.
- Non-spinning conflict retry gated on base SHA change.
- Flaky CI retry budget (separate from retry budget).
- Revalidation before merge (approval, SHA, external merge).
- Durable incident records on eviction.
- GitHub check run as eviction signal.
- Label-based admission and re-admission.
- Structured reconciler event stream for observability.

Not built yet (see [design doc](./design-docs/merge-steward.md)):

- Binary bisection on batch failure.
- File-path conflict detection for parallel lanes.
- Flaky test learning (only retry budget today, no historical analysis).
- Priority reordering after enqueue.
