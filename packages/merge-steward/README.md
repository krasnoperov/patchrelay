# merge-steward

Serial merge queue service. Rebases PRs onto main one at a time, waits for CI, and merges when green. Evicts on failure and reports incidents via GitHub check runs.

Fully independent of PatchRelay. Communicates through GitHub — PRs, labels, check runs, branches.

## How it works

1. A PR gets the `queue` label (manually, by PatchRelay, or by any automation)
2. The steward sees the label via GitHub webhook
3. If the PR is approved and CI is green, it enters the queue
4. The steward processes the queue head: fetch → rebase onto main → push → wait for CI → merge
5. On failure: retry (gated on base SHA change), then evict with a durable incident record and GitHub check run
6. PatchRelay (or any agent) sees the check run failure and can fix the branch
7. When the branch is fixed and CI passes again, adding the `queue` label re-admits it

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
- `/etc/systemd/system/merge-steward@.service`

Add one repo-scoped steward instance:

```bash
merge-steward attach app owner/repo --base-branch main --required-check test,lint
```

That writes `~/.config/merge-steward/repos/app.json`, enables `merge-steward@app.service`, and prints the repo-specific webhook URL.

Validate the setup:

```bash
merge-steward doctor --repo app
merge-steward service status app
merge-steward queue status --repo app
```

### Secrets

For dev, `service.env` can contain:

```bash
MERGE_STEWARD_WEBHOOK_SECRET=replace-with-webhook-secret
MERGE_STEWARD_GITHUB_TOKEN=replace-with-github-token
```

For production, prefer `systemd-creds` with:

- `LoadCredentialEncrypted=merge-steward-webhook-secret`
- `LoadCredentialEncrypted=merge-steward-github-token`

The steward resolves secrets in this order:

1. `$CREDENTIALS_DIRECTORY/<name>`
2. `${ENV_KEY}_FILE`
3. `${ENV_KEY}`

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
  "webhookPath": "/webhooks/github/queue/app",
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
| `admissionLabel` | GitHub label that triggers queue admission |
| `mergeQueueCheckName` | GitHub check run name emitted on eviction |
| `webhookPath` | Repo-specific webhook endpoint path |

### GitHub Webhook

Configure a webhook on the repository:

- **Payload URL:** the repo-specific URL printed by `merge-steward attach`, for example `https://queue.example.com/webhooks/github/queue/app`
- **Content type:** `application/json`
- **Secret:** same as `MERGE_STEWARD_WEBHOOK_SECRET`
- **Events:** Pull requests, Pull request reviews, Check suites, Pushes

### Running

```bash
# Happy path
merge-steward init https://queue.example.com
merge-steward attach app owner/repo --base-branch main --required-check test,lint
merge-steward doctor --repo app
merge-steward service status app
merge-steward queue status --repo app
merge-steward queue show --repo app --pr 123

# Manual foreground start
merge-steward serve --repo app

# Live queue watch TUI
merge-steward queue watch --repo app
```

### Watch TUI

`merge-steward queue watch --repo <id>` gives you a terminal view of the queue:

- which PRs are currently queued
- which PR is head-of-line
- current steward tick state
- recent queue transitions
- per-PR detail with incidents and event history

Controls:

- `j` / `k` or arrows — move selection
- `Enter` — open selected PR detail
- `Esc` — return to queue view
- `a` — toggle `active` vs `all`
- `r` — run a reconcile tick now
- `d` — dequeue the selected PR
- `q` — quit

### systemd

```ini
[Unit]
Description=merge-steward (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=-/home/your-user/.config/merge-steward/runtime.env
EnvironmentFile=-/home/your-user/.config/merge-steward/service.env
LoadCredentialEncrypted=merge-steward-webhook-secret
LoadCredentialEncrypted=merge-steward-github-token
ExecStart=/usr/bin/env merge-steward serve --repo %i
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

## API

| Endpoint | Method | Description |
|-|-|-|
| `/health` | GET | Liveness check |
| `/queue/status` | GET | All queue entries |
| `/queue/watch` | GET | Queue snapshot for the operator TUI |
| `/queue/enqueue` | POST | Manually enqueue a PR |
| `/queue/reconcile` | POST | Trigger one reconcile tick immediately |
| `/queue/entries/:id/detail` | GET | Entry detail with recent events and incidents |
| `/queue/entries/:id/dequeue` | POST | Remove from queue (non-destructive) |
| `/queue/entries/:id/update-head` | POST | Update head SHA (force-push) |
| `/queue/incidents/:id` | GET | Get incident details |
| `/queue/entries/:id/incidents` | GET | List incidents for an entry |
| `/webhooks/github/queue` | POST | GitHub webhook receiver (configurable via `webhookPath`) |

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
- **Speculative execution**: cumulative branches (`main+A`, `main+A+B`, `main+A+B+C`) tested in parallel. Configurable depth (default 3, set `speculativeDepth: 1` for serial mode).
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
