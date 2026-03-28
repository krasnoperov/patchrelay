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
- `gh` CLI authenticated (for GitHub API operations)
- `git` binary

### Configuration

Copy `config/steward.example.json` and adjust:

```json
{
  "repoId": "my-project",
  "repoFullName": "owner/repo",
  "baseBranch": "main",
  "clonePath": "~/.local/state/merge-steward/repos/my-project",
  "maxRetries": 2,
  "flakyRetries": 1,
  "requiredChecks": [],
  "pollIntervalMs": 30000,
  "admissionLabel": "queue",
  "webhookSecret": "your-webhook-secret",
  "server": {
    "bind": "127.0.0.1",
    "port": 8790
  },
  "database": {
    "path": "~/.local/state/merge-steward/steward.sqlite"
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
| `webhookPath` | Webhook endpoint path (default `/webhooks/github/queue`) |
| `webhookSecret` | GitHub webhook secret for signature verification |

### GitHub Webhook

Configure a webhook on the repository:

- **Payload URL:** `http://your-host:8790/webhooks/github/queue`
- **Content type:** `application/json`
- **Secret:** same as `webhookSecret` in config
- **Events:** Pull requests, Pull request reviews, Check suites, Pushes

### Running

```bash
# Build
npm run build -w merge-steward

# Start
MERGE_STEWARD_CONFIG=config/steward.json merge-steward serve

# Or with --config flag
merge-steward serve --config config/steward.json

# Live queue watch TUI
merge-steward watch --config config/steward.json
```

### Watch TUI

`merge-steward watch` gives you a terminal view of the queue:

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
Description=merge-steward
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/env merge-steward serve --config /etc/merge-steward/steward.json
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
- The steward merges the PR or evicts it (creating a `merge-steward/queue` check run)
- PatchRelay watches for that check run failure and triggers `queue_repair`
- After repair, PatchRelay re-adds the `queue` label
- The steward re-admits the PR

Neither service calls the other's API. GitHub is the shared bus.

## Current scope (Phase 1)

This is a **serial merge queue**. One PR is processed at a time.

What's implemented:
- Serial queue: rebase → CI → merge, one head at a time
- Non-spinning conflict retry: gated on base SHA change (won't rebase repeatedly against the same broken base)
- Flaky CI retry budget (separate from retry budget)
- Revalidation before merge (approval, SHA, external merge)
- Durable incident records on eviction
- GitHub check run as eviction signal
- Label-based admission and re-admission

What's deliberately not built yet (Phase 2/3 in the [design doc](../../docs/design-docs/merge-steward.md)):
- Speculative execution (cumulative branches `main+A+B+C` tested in parallel)
- Binary bisection on batch failure
- File-path conflict detection for parallel lanes
- Flaky test learning (only retry budget, no historical analysis)
- Priority reordering after enqueue

The serial queue is correct for usertold's scale (5-20 PRs/day). Speculative execution is a throughput optimization for higher volumes.
