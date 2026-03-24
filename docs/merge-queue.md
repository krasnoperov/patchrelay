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

### 3. GitHub CLI Auth

PatchRelay uses the host's `gh` CLI authentication to enable auto-merge and create PRs.

**Default (no App configured):** Uses the host's existing `gh auth` session. Ensure `gh auth status` shows a logged-in account with `repo` scope.

**With GitHub App identity (optional):** PatchRelay can operate as a bot (`app-name[bot]`) instead of your personal account. Add to `~/.config/patchrelay/service.env`:

```bash
PATCHRELAY_GITHUB_APP_ID=123456
PATCHRELAY_GITHUB_APP_PRIVATE_KEY_FILE=/home/your-user/.config/patchrelay/github-app.pem
```

PatchRelay generates short-lived installation tokens, writes them to `~/.local/share/patchrelay/gh-token`, and installs a `gh` wrapper at `~/.local/share/patchrelay/bin/gh` that reads the token. Codex picks up the wrapper via PATH. Your personal `gh` auth is untouched — the wrapper only activates when the token file exists.

Git push uses the host's existing git credentials (SSH keys or credential helper). Commit authorship is independent of push credentials.

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

### 5. GitHub App Events

The PatchRelay GitHub App receives webhook events for all repos it's installed on. Configure the subscribed events in the App settings at `Settings → Developer settings → GitHub Apps → PatchRelay → Permissions & events → Subscribe to events`:

| Event | Required for |
|-|-|
| Push | Advancing the merge queue when main updates |
| Pull request | PR opened/closed/merged state tracking |
| Pull request review | Approval and change-request detection |
| Check suite | CI pass/fail state transitions |
| Check run | PR metadata (observability) |

The webhook URL (`https://<your-patchrelay-host>/webhooks/github`) and secret (`GITHUB_APP_WEBHOOK_SECRET`) are configured in the App's "General" settings.

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
