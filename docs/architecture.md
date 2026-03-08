# PatchRelay Architecture

## System Shape

PatchRelay v1 is a single local service with four responsibilities:

1. accept and verify Linear webhooks
2. persist webhook and run state in SQLite
3. create per-issue git worktrees and branches
4. launch `zmx` / Codex with a workflow file and webhook-derived issue metadata

It is intentionally not a Linear synchronization engine.

## Request Flow

### 1. Webhook Intake

Caddy forwards `POST /webhooks/linear` to the local PatchRelay service.

PatchRelay:

- reads the raw request body
- verifies the HMAC signature
- validates timestamp freshness
- rejects malformed payloads
- deduplicates by webhook delivery id
- stores the webhook payload in SQLite
- enqueues asynchronous processing

The HTTP response is fast and does not wait for git or agent work.

### 2. Metadata Extraction

The worker extracts issue metadata from the webhook payload itself.

The minimum useful fields are:

- issue id
- issue key when present
- issue title when present
- issue URL when present
- team metadata when present
- label metadata when present

Issue metadata is not refreshed from Linear before launch in v1.

### 3. Project Resolution

PatchRelay resolves a local project using webhook metadata.

The configured selectors are:

- `linear_team_ids`
- `allow_labels`
- `trigger_events`

If exactly one project is configured, PatchRelay may use it directly.

If no project matches, the event is marked ignored after persistence.

### 4. Workflow Selection

PatchRelay selects a workflow only when a status change webhook moves an issue into a configured automation state.

The expected status set is:

- `Todo`
- `Start`
- `Implementing`
- `Review`
- `Reviewing`
- `Deploy`
- `Deploying`
- `Human Needed`
- `Done`

Default mapping:

- `Start` -> implementation
- `Review` -> review
- `Deploy` -> deploy

Other statuses such as `Todo`, `Implementing`, `Reviewing`, `Deploying`, `Human Needed`, and `Done` do not launch work.

### 5. Local Launch

For a matched project, PatchRelay:

1. computes the worktree path from the issue id
2. computes the branch name from the configured prefix, issue id, and title
3. creates or refreshes the worktree from the repository `HEAD`
4. launches a named `zmx` session
5. runs Codex in that worktree with issue metadata and the selected workflow file path

PatchRelay passes the Codex automation flags explicitly in the configured command and does not rely on shell aliases from interactive dotfiles.

### 6. Local State Tracking

PatchRelay records:

- that the run was launched
- which branch and worktree were used
- which `zmx` session name was created
- whether the session later exited successfully or failed

## Logging And Archives

PatchRelay writes:

- a structured JSON log stream to stdout and to a required local file
- one archived JSON file per received webhook under `logging.webhook_archive_dir`
- explicit processing logs for normalized issue metadata, project resolution, ignored events, launch plans, and session exits
- explicit command logs for `git worktree add` and the `zmx` launch command

## Configuration

Each project defines:

- repository path
- worktree root
- workflow files
- workflow-trigger statuses
- branch prefix
- team selectors
- label selectors
- trigger events

Example:

```yaml
projects:
  - id: patchrelay
    repo_path: /home/alv/projects/patchrelay
    worktree_root: /home/alv/worktrees/patchrelay
    workflow_files:
      implementation: /home/alv/projects/patchrelay/IMPLEMENTATION_WORKFLOW.md
      review: /home/alv/projects/patchrelay/REVIEW_WORKFLOW.md
      deploy: /home/alv/projects/patchrelay/DEPLOY_WORKFLOW.md
    workflow_statuses:
      implementation: Start
      review: Review
      deploy: Deploy
    linear_team_ids:
      - ENG
    allow_labels: []
    trigger_events:
      - statusChanged
    branch_prefix: patchrelay
```

## Security Model

PatchRelay v1 relies on Linear’s normal webhook security model:

- webhook signing secret
- raw-body HMAC verification
- timestamp freshness checks
- delivery id deduplication

There is no extra path suffix in v1.

## Deliberate Omissions

PatchRelay v1 does not include:

- pre-launch GraphQL fetches
- Linear comments
- Linear state transitions
- OAuth token management
- internal safety orchestration
