# merge-steward

`merge-steward` is a self-hosted merge queue for bot-managed and human-managed
GitHub pull requests. It admits approved PRs whose required checks are green,
builds cumulative speculative branches, waits for CI on those exact integrated
SHAs, and then fast-forwards `main` to the tested result. On failure, it evicts
with a durable incident record and GitHub check run so an agent or human can
repair the branch and re-queue it.

Fully independent of PatchRelay. Communicates through GitHub — PRs, reviews,
checks, labels, branches.

Shared protocol:

- [../../docs/design-docs/pr-automation-loop.md](../../docs/design-docs/pr-automation-loop.md)

## How it works

1. A PR becomes eligible when GitHub says it is approved and its required checks are green
2. The steward notices that through webhook wakeups or startup/reconcile scans
3. It admits the PR into the queue; the optional `queue` label is just an operator-friendly nudge, not the sole trigger
4. The steward builds a speculative branch:
   - head of queue: `main + PR`
   - downstream entries: cumulative specs like `main + A + B`
5. CI runs on that speculative SHA
6. If the queue head's speculative SHA is still a fast-forward from current `main`, the steward pushes that exact SHA to `main`
7. On failure: retry (gated on base SHA change), then evict with a durable incident record and GitHub check run
8. PatchRelay (or any agent) sees the check run failure and can fix the branch
9. When the branch is fixed and CI passes again, the PR can be re-admitted

## Setup

### Prerequisites

- Node.js 24+
- `gh` CLI available in `PATH`
- `git` binary

### Bootstrap

Initialize the machine-level steward home once:

```bash
merge-steward init https://queue.example.com
```

That creates:

- `~/.config/merge-steward/runtime.env`
- `~/.config/merge-steward/service.env`
- `~/.config/merge-steward/merge-steward.json`
- `~/.config/merge-steward/repos/`
- `/etc/systemd/system/merge-steward.service`

Add one repo-scoped steward instance:

```bash
merge-steward attach owner/repo
```

That writes `~/.config/merge-steward/repos/<derived-id>.json`. By default, `attach` derives the repo id from the GitHub repo name, discovers the default branch and required status checks from GitHub, and stores the discovered values into local config.

If you also use `review-quill`, its `review-quill/verdict` check can be added to
the repository's required checks if you want machine review to be part of the
merge gate. Steward will naturally follow whatever required checks the repo
configuration uses, but its primary admission gate is still GitHub's formal
review state plus those required checks.

Validate the setup:

```bash
merge-steward doctor --repo repo
merge-steward service status
merge-steward queue status --repo repo
```

### Secrets

Keep only non-secret identifiers in:

- `~/.config/merge-steward/service.env`

Example:

```bash
MERGE_STEWARD_GITHUB_APP_ID=123456
MERGE_STEWARD_GITHUB_APP_INSTALLATION_ID=12345678
```

Store secrets in encrypted systemd credentials:

- `/etc/credstore.encrypted/merge-steward-webhook-secret.cred`
- `/etc/credstore.encrypted/merge-steward-github-app-pem.cred`

The running service resolves the webhook secret in this order:

1. `$CREDENTIALS_DIRECTORY/<name>`
2. `${ENV_KEY}_FILE`
3. `${ENV_KEY}`

The running service resolves GitHub auth in this order:

1. `MERGE_STEWARD_GITHUB_APP_ID` + `merge-steward-github-app-pem` / `MERGE_STEWARD_GITHUB_APP_PRIVATE_KEY`

In practice, use:

- `merge-steward-webhook-secret` for validating incoming GitHub webhooks
- `MERGE_STEWARD_GITHUB_APP_ID` plus `merge-steward-github-app-pem` for production GitHub auth
- `MERGE_STEWARD_GITHUB_APP_INSTALLATION_ID` if you want to pin a single installation instead of resolving one per repo

When GitHub App auth is configured, Merge Steward mints short-lived installation tokens and uses them for both `gh` API calls and `git clone/fetch/push` over HTTPS. In multi-repo setups it resolves the installation per repository, so repos in different GitHub App installations can still coexist.

Recommended GitHub App repository permissions:

- `Contents: Read and write`
- `Pull requests: Read and write`
- `Checks: Read and write`
- `Metadata: Read-only`
- `Administration: Read-only`

`Contents: Read and write` is the important merge-path permission because the
steward lands tested speculative SHAs by fast-forward pushing `main`.
`Administration: Read-only` is not required for merging itself, but it lets the
doctor and attach/refresh flows discover branch rules and required checks
without falling back to a local `gh` user token.

The machine-level env files created by `merge-steward init` are:

- `~/.config/merge-steward/runtime.env`
- `~/.config/merge-steward/service.env`

`runtime.env` is for non-secret runtime settings.
`service.env` is for non-secret machine-level service config like `MERGE_STEWARD_GITHUB_APP_ID`.
The CLI is a thin local client and does not need direct access to secret credentials.

### Repo Config

`merge-steward attach` writes a repo-scoped config like:

```json
{
  "repoId": "app",
  "repoFullName": "owner/repo",
  "baseBranch": "main",
  "clonePath": "~/.local/state/merge-steward/repos/app",
  "maxRetries": 2,
  "flakyRetries": 1,
  "requiredChecks": ["test", "lint"],
  "pollIntervalMs": 30000,
  "admissionLabel": "queue",
  "mergeQueueCheckName": "merge-steward/queue",
  "server": {
    "bind": "127.0.0.1",
    "port": 8790
  },
  "database": {
    "path": "~/.local/state/merge-steward/app.sqlite"
  }
}
```

| Field | Description |
|-|-|
| `repoId` | Internal ID for this repo (used in DB keys) |
| `repoFullName` | GitHub `owner/repo` |
| `baseBranch` | Target branch for merges (usually `main`) |
| `clonePath` | Local clone directory (created on first run) |
| `maxRetries` | Rebase/CI retry attempts before eviction |
| `flakyRetries` | CI-only retries before counting toward maxRetries |
| `requiredChecks` | Check names that must pass for admission (empty = any green) |
| `pollIntervalMs` | Reconciliation loop interval |
| `admissionLabel` | Optional GitHub label used as a manual/operator admission nudge |
| `mergeQueueCheckName` | GitHub check run name emitted on eviction |

`attach` discovers these values from GitHub when possible:

- `repoId` defaults to the repo name portion of `owner/repo`
- `baseBranch` defaults to the GitHub default branch
- `requiredChecks` default to the active `required_status_checks` branch rules for the configured base branch

Pass `--refresh` to re-discover base branch and required checks for an existing repo config. `merge-steward doctor --repo <id>` compares the stored config to GitHub and warns on drift.

### GitHub Webhook

Configure one webhook on the repository pointing to the steward:

- **Payload URL:** `https://queue.example.com/webhooks/github`
- **Content type:** `application/json`
- **Secret:** same as `MERGE_STEWARD_WEBHOOK_SECRET` or the `merge-steward-webhook-secret` systemd credential
- **Events:** Pull requests, Pull request reviews, Check suites, Pushes

The steward uses a single multi-repo webhook endpoint and routes events by `repository.full_name`.

It can wake up on:

- PR label changes
- review approvals
- successful check-suite completion
- pushes to the base branch

Even without a webhook, startup and periodic reconcile will still scan open PRs
and admit anything that already satisfies the gate.

### Running

```bash
# Happy path
merge-steward init https://queue.example.com
merge-steward attach owner/repo
merge-steward doctor --repo repo
merge-steward service status
merge-steward queue status --repo repo
merge-steward queue show --repo repo --pr 123
merge-steward dashboard

# Manual foreground start
merge-steward serve

# Open one project directly in the dashboard
merge-steward dashboard --repo app
```

### Dashboard

`merge-steward dashboard` is the operator surface for day-to-day queue work.

The first screen shows all configured projects with:

- project-level queue health
- readable queue stats
- a compact queue chain like `#123 ●  #124 ○`
- clear bad states such as blocked, stuck, or needs attention

Press `Enter` on a project to open the second screen. That project detail view shows:

- the same top-level queue stats for that project
- a readable list of PRs in the queue
- recent queue activity in plain language
- incidents for evicted PRs
- direct actions like reconcile and dequeue

Use `merge-steward dashboard --repo <id>` to open the project detail screen directly. Use `--pr <number>` to preselect a PR when you already know what you need to inspect.

Controls:

- `j` / `k` or arrows — move selection
- `Enter` — open the selected project from overview
- `Esc` — return to the overview
- `a` — toggle `active` vs `all` in project view
- `r` — run a reconcile tick for the selected project
- `d` — dequeue the selected PR in project view
- `q` — quit

### Validation, Visibility, And Troubleshooting

These are the first commands to reach for after setup or when a queue looks wrong:

```bash
merge-steward doctor --repo app
merge-steward service status
merge-steward service restart
merge-steward dashboard
merge-steward queue status --repo app
merge-steward queue show --repo app --pr 123
merge-steward service logs --lines 100
```

Use them this way:

- `doctor` checks config, GitHub auth, branch rules, and required checks.
- `dashboard` is the best live operator view across all configured projects.
- `queue status` is the fastest text snapshot when you need one repo in a shell script or over SSH.
- `queue show --pr <number>` is the most direct way to inspect one PR's queue events and incidents.
- `service logs` helps when the queue is not reacting to webhooks, GitHub auth is failing, or reconcile ticks are erroring.

### systemd

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

## API

| Endpoint | Method | Description |
|-|-|-|
| `/health` | GET | Liveness check |
| `/repos/:repoId/queue/status` | GET | All queue entries for one configured repo |
| `/repos/:repoId/queue/watch` | GET | Queue snapshot used by the dashboard |
| `/repos/:repoId/queue/enqueue` | POST | Manually enqueue a PR |
| `/repos/:repoId/queue/reconcile` | POST | Trigger one reconcile tick immediately |
| `/repos/:repoId/queue/entries/:id/detail` | GET | Entry detail with recent events and incidents |
| `/repos/:repoId/queue/entries/:id/dequeue` | POST | Remove from queue (non-destructive) |
| `/repos/:repoId/queue/entries/:id/update-head` | POST | Update head SHA (force-push) |
| `/repos/:repoId/queue/incidents/:id` | GET | Get incident details |
| `/repos/:repoId/queue/entries/:id/incidents` | GET | List incidents for an entry |
| `/webhooks/github` | POST | GitHub webhook receiver for all configured repos |

## Queue state machine

```
queued → preparing_head → validating → merging → merged
                                              → evicted (on failure after retries)
```

- **queued**: waiting in line
- **preparing_head**: fetching + rebasing onto base branch
- **validating**: CI running
- **merging**: revalidation + merge
- **merged**: done
- **evicted**: failed after retry budget, incident created
- **dequeued**: manually removed

## Merge Gate

For the steward path, the real gate is:

- GitHub says the PR review state is approved
- the configured required checks are green
- the steward's speculative integrated branch also passes CI

`review-quill/verdict` only matters if you choose to include it in the repo's
required checks.

GitHub branch protection is still useful as defense in depth, but steward does
not merge by pressing GitHub's merge button. It fast-forwards `main` to the
already-tested speculative SHA, so successful queue merges also depend on the
steward App being allowed to push that result to the protected branch.

## Interaction with PatchRelay

The steward and PatchRelay are independent services that communicate through GitHub:

- PatchRelay adds the `queue` label when an issue reaches `awaiting_queue`
- The steward merges the PR or evicts it (creating the configured queue eviction check run, default `merge-steward/queue`)
- PatchRelay watches for that check run failure and triggers `queue_repair`
- After repair, PatchRelay re-adds the `queue` label
- The steward re-admits the PR

Neither service calls the other's API. GitHub is the shared bus.

## Current scope

What's implemented:
- **Speculative execution**: cumulative branches (`main+A`, `main+A+B`, `main+A+B+C`) tested in parallel. Configurable depth (default 10, set `speculativeDepth: 1` for serial mode).
- **Speculative consistency**: when head merges, downstream entries that already passed don't re-test.
- **Cascade invalidation**: when mid-chain entry fails, downstream speculative branches are rebuilt without it.
- Non-spinning conflict retry: gated on base SHA change
- Flaky CI retry budget (separate from retry budget)
- Revalidation before merge (approval, SHA, external merge)
- Durable incident records on eviction
- GitHub check run as eviction signal
- Label-based admission and re-admission
- Structured reconciler event stream for observability

What's not built yet (see [design doc](https://github.com/krasnoperov/patchrelay/blob/main/docs/design-docs/merge-steward.md)):
- Binary bisection on batch failure
- File-path conflict detection for parallel lanes
- Flaky test learning (only retry budget, no historical analysis)
- Priority reordering after enqueue
