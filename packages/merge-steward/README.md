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
| `webhookSecret` | GitHub webhook secret for signature verification |

### GitHub Webhook

Configure a webhook on the repository:

- **Payload URL:** `http://your-host:8790/webhooks/github`
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
```

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
| `/queue/enqueue` | POST | Manually enqueue a PR |
| `/queue/entries/:id/dequeue` | POST | Remove from queue (non-destructive) |
| `/queue/entries/:id/update-head` | POST | Update head SHA (force-push) |
| `/queue/incidents/:id` | GET | Get incident details |
| `/queue/entries/:id/incidents` | GET | List incidents for an entry |
| `/webhooks/github` | POST | GitHub webhook receiver |

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
