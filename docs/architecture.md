# PatchRelay Architecture

## System Shape

PatchRelay is a self-hosted execution harness around Codex with seven responsibilities:

1. accept and verify Linear webhooks
2. persist issue, workspace, pipeline, stage, and observation state in SQLite
3. create and maintain per-issue git worktrees
4. drive Codex through `codex app-server`
5. write deterministic workflow state back to Linear
6. steer active turns with queued Linear agent input and optional compatibility comments
7. expose local management routes and, optionally, issue and stage inspection endpoints

`codex app-server` is the source of truth for agent thread history.
PatchRelay is the source of truth for workflow policy, workspace ownership, and issue-to-thread correlation.

The key design constraint is that PatchRelay remains the harness around the model. It should keep deterministic workflow coordination out of the prompt layer while avoiding repo-specific business logic that belongs in workflow files or agent tools.

## Layer Model

PatchRelay is easiest to reason about as five layers:

### 1. Policy Layer

Repository-owned workflow files define stage behavior, prompt instructions, and team-specific rules.

### 2. Coordination Layer

The service decides when an issue is eligible, which stage should run next, whether a run should retry, and how restart reconciliation should resolve partially completed work.

### 3. Execution Layer

PatchRelay owns durable worktrees, Codex thread lifecycle, turn startup, and queued human follow-up input delivery.

### 4. Integration Layer

PatchRelay verifies Linear webhooks, performs OAuth and installation linking, routes issues to the right project, and applies deterministic state changes back to Linear.

### 5. Observability Layer

PatchRelay exposes reports, event history, active-stage inspection, and operator-facing CLI and API surfaces.

These layers are intentionally separate:

- policy tells the agent how to work
- coordination decides when work should run
- execution performs the work in the repo
- integration keeps external systems consistent
- observability explains what happened

For a current file-by-file view of those boundaries, see [module-map.md](./module-map.md).

## Main Entities

### Tracked Issue

One record per Linear issue per project.

Stores:

- Linear issue id and key
- latest known Linear state
- desired next stage
- active workspace id
- active pipeline id
- active stage run id
- latest Codex thread id
- optional service-owned Linear status comment id for fallback delivery

### Workspace

One durable git worktree and branch for an issue lifecycle.

Stores:

- branch name
- worktree path
- workspace status
- last completed stage
- last Codex thread id

### Pipeline Run

A logical automation lifecycle for an issue workspace.

Stores:

- workspace id
- active stage
- pipeline status
- start and end timestamps

### Stage Run

One concrete `development`, `review`, `deploy`, or `cleanup` execution.

Stores:

- workflow stage
- workflow file path
- prompt text
- Codex thread id
- parent thread id
- turn id
- stage status
- report payload

### Thread Event

A persisted Codex app-server notification correlated to a stage run.

Stores:

- thread id
- optional turn id
- notification method
- raw event JSON

## Authoritative Versus Derived State

PatchRelay keeps a harness ledger in SQLite, but not every artifact deserves to be authoritative state.

Authoritative state is the data PatchRelay must recover exactly after a restart in order to continue or safely stop automation:

- webhook dedupe and processing state
- Linear installation and OAuth state
- issue-to-workspace ownership
- issue-to-thread and stage-run correlation
- active and desired stage coordination

Derived state is anything PatchRelay can rebuild or re-read from another durable source:

- Codex thread transcript details
- verbose event trails
- rendered reports and operator views
- current Linear issue fields that can be fetched again

This distinction is important when extending the service. New persistence should default to derived or cache-like storage unless the information is required for coordination, restart safety, or deterministic Linear writeback.

For the current classification of stored entities, see [persistence-audit.md](./persistence-audit.md).

## Request Flow

### 1. Webhook Intake

PatchRelay:

- reads the raw request body
- verifies the Linear HMAC signature
- validates timestamp freshness
- deduplicates by delivery id
- archives the webhook payload
- persists a webhook receipt row
- enqueues asynchronous processing

### 2. Issue Routing

PatchRelay resolves a local project from:

- issue key prefix such as `USE`
- Linear team metadata
- optional labels
- allowed trigger events

Issue key prefix is the primary routing key.

### 3. Desired Stage Recording

PatchRelay maps Linear states to internal stages:

- `Start` -> `development`
- `Review` -> `review`
- `Deploy` -> `deploy`
- optional configured cleanup state -> `cleanup`

When PatchRelay claims a stage, it also moves the issue into the matching active state:

- `development` -> `Implementing`
- `review` -> `Reviewing`
- `deploy` -> `Deploying`

The service records the desired stage even if another stage is still running.
For app-mode projects, PatchRelay only records a new desired stage from native agent-session events such as delegation or mention prompts. Bare issue state changes no longer launch work on their own.

### 4. Workspace Preparation

When no active stage run exists, PatchRelay:

1. computes the worktree path from the issue key
2. computes the branch name from the configured prefix, issue key, and title
3. reuses the existing issue worktree when present, otherwise creates it from repository `HEAD`
4. creates or reuses the issue workspace row

### 5. Codex Thread Execution

For the next stage run:

- if this is the first stage for the issue, PatchRelay calls `thread/start`
- if a prior stage exists, PatchRelay calls `thread/fork`
- PatchRelay then calls `turn/start` with the issue context and workflow file contents
- for delegated Linear agent sessions, PatchRelay first sends a native agent-session acknowledgement and refreshes session presentation such as the external status URL and workflow plan
- while preparing the run, PatchRelay also claims the matching active Linear state and applies configured workflow labels
- after the turn is live, PatchRelay flushes any queued Linear agent input and best-effort refreshes either the native Linear agent session presentation or, for fallback flows, the service-owned running status comment

The resulting thread id and turn id are persisted immediately.

### 6. Observation And Completion

PatchRelay listens to `codex app-server` notifications such as:

- `turn/started`
- `turn/completed`
- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- `turn/plan/updated`
- `turn/diff/updated`

On `turn/completed`, PatchRelay:

1. stores the final notification
2. reads the full thread with `thread/read`
3. synthesizes a stage report
4. marks the stage run completed or failed
5. re-reads Linear to see whether the agent advanced the issue to a final handoff state
6. if the issue is still in the active state PatchRelay set, updates the native Linear agent session handoff state when available, otherwise refreshes the service-owned Linear comment, and updates workflow labels to flag that handoff is still needed
7. if the issue has already moved on, clears any service-owned workflow labels
8. launches any queued next stage

If stage launch fails before a turn is live, PatchRelay marks the stage failed locally, rolls the issue to the configured fallback Linear state such as `Human Needed`, removes service-owned workflow labels, and publishes the failure through the native Linear agent session when available, otherwise through the service-owned comment. If PatchRelay later finds an unrecoverable active stage during startup reconciliation, it applies the same failure sync back to Linear only when the issue is still in the service-owned active state.

## Reconciliation And Restart

Restart behavior is a first-class architectural requirement.

After process startup, PatchRelay must reconcile three realities:

1. Linear state
2. local harness state
3. Codex thread and stage state

The reconciliation loop should answer:

- is this issue still eligible for the stage PatchRelay last claimed
- is there an active stage that can continue, or only state that needs cleanup
- does Linear still reflect the service-owned active state, or has a human already moved the issue on
- should PatchRelay resume, queue follow-up work, or fail the stage back to a human-needed state

This is why PatchRelay persists stage ownership and issue-to-thread correlation instead of relying only on Linear or only on Codex. Linear is the control surface, Codex is the source of thread history, and PatchRelay is the layer that makes restart recovery deterministic.

## Why App-Server

This design intentionally avoids terminal multiplexers as the workflow backbone.

We need:

- durable thread ids
- resumable and forkable stage history
- read-only inspection after a run finishes
- stage sequencing independent from terminal session lifetime

`codex app-server` provides those primitives directly.

## Persistence Summary

SQLite stores:

- webhook receipts
- issue control
- issue projection
- workspace ownership
- run leases
- obligations
- run reports
- run thread events
- installation and OAuth state

The database is not a copy of Codex thread history. It is the harness ledger that points to thread history and caches reports.

## Operator Surface

PatchRelay always exposes local management routes for:

- Linear OAuth start and callback handling
- installation listing
- project-to-installation linking

When `operator_api.enabled` is on, PatchRelay also exposes:

- issue overview by issue key
- stage reports by issue key
- live active-stage status by issue key
- raw stage event history by issue key and stage run id

The operator can inspect what happened without attaching to a live terminal.
