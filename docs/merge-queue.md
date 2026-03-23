# Merge Queue

PatchRelay includes a built-in serial merge queue that updates PR branches to the latest base branch, handles merge conflicts via Codex, and merges via GitHub auto-merge. No external merge queue service or GitHub Actions workflow is needed.

## How It Works

When the AI Review Action approves a PR, PatchRelay:

1. Enables auto-merge (`gh pr merge --auto --squash`)
2. Updates the PR branch by merging the latest base branch in the worktree
3. Pushes the updated branch (triggering CI)
4. GitHub auto-merge fires when CI passes, approval is valid, and the branch is up-to-date

When one PR merges, PatchRelay advances the queue — finding the next approved PR and updating its branch.

### Serialization

Only the front-of-queue PR (lowest PR number in `awaiting_queue`) gets its branch updated. Other approved PRs wait. After the front PR merges, PatchRelay advances the next one. This prevents wasted CI runs and ensures each PR is tested against the true state of the base branch.

### Merge Conflicts

When the base branch merge fails in the worktree:

1. PatchRelay aborts the merge and transitions to `repairing_queue`
2. A `queue_repair` run starts — Codex rebases onto the base branch, resolves conflicts, and pushes
3. CI runs on the resolved code
4. The issue returns to `awaiting_queue` and the merge queue re-prepares it

No conflict markers are committed. Codex resolves conflicts in PatchRelay's durable worktree with full git history and Linear issue context.

### CI Failures After Branch Update

If CI fails after the branch is updated:

1. PatchRelay transitions to `repairing_ci`
2. Codex reads CI logs, fixes the code, and pushes
3. CI passes → PatchRelay fast-tracks the issue back to `awaiting_queue` (the PR is already approved)
4. The merge queue re-prepares the branch if needed

## Setup

### 1. Repository Settings

- **Allow auto-merge**: Enable in Settings → General

### 2. Branch Protection Rules

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

**Why "Dismiss stale approvals" must be disabled:** Branch updates must not invalidate the AI review approval.

**Why "Require approval of the most recent reviewable push" must be disabled:** PatchRelay's merge prep and repair runs push commits. This setting would require re-approval after each push.

### 3. GitHub Token

Add `GITHUB_TOKEN` to PatchRelay's `~/.config/patchrelay/service.env`:

```bash
GITHUB_TOKEN=ghp_your_personal_access_token
```

This token is used for `gh pr merge --auto --squash`. It needs `repo` scope (classic PAT) or `contents: write` + `pull_requests: write` (fine-grained PAT).

Git push uses the PatchRelay host's existing SSH keys, which trigger CI. The `GITHUB_TOKEN` is not used for push.

### 4. Project Config

Add `baseBranch` to the project's GitHub config (defaults to `main` if omitted):

```json
{
  "id": "your-project",
  "repoPath": "/path/to/repo",
  "github": {
    "repoFullName": "owner/repo",
    "baseBranch": "main"
  }
}
```

### 5. GitHub Webhook

Configure the repository webhook to send events to PatchRelay:

| Field | Value |
|-|-|
| Payload URL | `https://<your-patchrelay-host>/webhooks/github` |
| Content type | `application/json` |
| Secret | Your `GITHUB_APP_WEBHOOK_SECRET` value |
| Events | Push, Pull requests, Pull request reviews, Check suites, Check runs |

### 6. Workflow Files

The target repository should contain:

- **`IMPLEMENTATION_WORKFLOW.md`** — guidance for implementation, CI repair, and queue repair runs
- **`REVIEW_WORKFLOW.md`** — guidance for review fix runs

## Flow Summary

```
Linear issue delegated to PatchRelay
  → Codex implements, opens PR, pushes
  → CI runs → green
  → AI Review approves PR
  → PatchRelay: awaiting_queue
    → enables auto-merge
    → merges base branch into worktree, pushes
  → CI runs on updated branch → green
  → GitHub auto-merge merges the PR
  → PatchRelay: done → advances next PR
```
