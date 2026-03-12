# Final Ledger Transition Plan

Status: completed.

PatchRelay now runs on the ledger-first model described here. The legacy workflow tables named in
this document are gone from the active schema and runtime paths. The remaining open work, if we
want it, is organizational: shrinking the compatibility adapter layer around synthesized workflow
view models.

This document is now best read as a description of the final architecture plus a historical record
of the sequence that got us there. The current source of truth is the codebase’s ledger-first
schema and runtime behavior.

## Goal

Describe the final ledger-first workflow model.

After this transition, PatchRelay should have:

- one authoritative coordination ledger
- one small projection layer for operator lookups
- one artifact layer for reports and event history
- no runtime dependence on `tracked_issues`, `workspaces`, `pipeline_runs`, `stage_runs`, or
  `queued_turn_inputs`

The end state is intentionally simple:

- `event_receipts`
- `issue_control`
- `workspace_ownership`
- `run_leases`
- `obligations`
- installation and OAuth tables
- a few explicit projection and artifact tables

Everything else should be deleted.

## End-State Architecture

### Authoritative Ledger

These tables remain and own correctness:

- `event_receipts`
  Deduplication, acceptance, and webhook processing ownership.
- `issue_control`
  Desired stage, active run lease, active workspace ownership, lifecycle status, and service-owned
  Linear anchors.
- `workspace_ownership`
  Durable issue-to-worktree ownership.
- `run_leases`
  The only execution record used for launch, restart, completion, and failure.
- `obligations`
  The only durable source of pending work that must be delivered after restart.

### Projection Layer

These tables exist only to make the CLI and HTTP surfaces pleasant:

- `issue_projection`
  Cached issue key, title, URL, current Linear state, and last-seen metadata.

Projection rules:

- projections are never used to decide ownership or next action
- projections may be stale or absent
- runtime paths must tolerate rebuilding them from live Linear reads

### Artifact Layer

These tables exist only for operator history and reports:

- `run_reports`
  Summary JSON and report JSON keyed by `run_lease_id`
- `run_thread_events`
  Event history keyed by `run_lease_id`

Artifact rules:

- artifacts are not required for restart correctness
- missing artifacts must not block recovery
- artifacts should be keyed by `run_lease_id`, not by any legacy stage-run id

## Legacy That Disappeared

These were removed as part of the cleanup:

- `tracked_issues`
- `workspaces`
- `pipeline_runs`
- `stage_runs`
- `queued_turn_inputs`
- `IssueWorkflowStore`
- most of `workflow-ports.ts`

These runtime concepts were removed or downgraded from authority inputs:

- `activeWorkspaceId`
- `activePipelineRunId`
- `activeStageRunId`
- `latestThreadId`
- `statusCommentId` on tracked issues as an authority input
- `pendingLaunchInput`
- `claimStageRun`
- `finishStageRun`
- `listActiveStageRuns`
- `getLatestStageRunForIssue` as anything other than history

## Transition Strategy Used

The rest of this document preserves the ordered transition plan that was executed to reach the
current state. It is retained for context and review history, not as an active migration checklist.

### Step 1: Add ledger-native projection and artifact tables

Add:

- `issue_projection`
- `run_reports`
- `run_thread_events`

Rules:

- `issue_projection` is keyed by `(project_id, linear_issue_id)`
- `run_reports` is keyed by `run_lease_id`
- `run_thread_events` is keyed by `run_lease_id`

Do not add new mixed tables. Keep projections and artifacts separate.

### Step 2: Replace stage-run keyed artifacts with run-lease keyed artifacts

Move:

- `summary_json`
- `report_json`
- `thread_events`
- operator event history

off legacy `stageRunId` and onto `runLeaseId`.

Keep legacy mirror rows readable during the migration if needed, but stop writing new authoritative
data there once the new artifact tables exist.

### Step 3: Replace pending launch input and queued turn input with obligations only

Remove correctness dependence on:

- `tracked_issues.pending_launch_input`
- `queued_turn_inputs`

New rule:

- every undelivered operator input is an `obligation`
- launch input is just another obligation kind
- delivery state lives only in `obligations`

If mirrored input rows are still useful for history during the transition, they must become derived
trace rows only.

### Step 4: Replace legacy issue metadata reads with `issue_projection`

Move CLI and HTTP lookup entry points from:

- `tracked_issues.issue_key`
- `tracked_issues.title`
- `tracked_issues.issue_url`
- `tracked_issues.current_linear_state`

to `issue_projection`.

Update:

- [src/cli/data.ts](../src/cli/data.ts)
- [src/issue-query-service.ts](../src/issue-query-service.ts)
- any lookup helpers in [src/http.ts](../src/http.ts)

After this step, `tracked_issues` should no longer be needed for operator lookup.

### Step 5: Make launch fully ledger-native

Change [src/service-stage-runner.ts](../src/service-stage-runner.ts) so launch no longer creates or
claims legacy workflow rows.

Replace:

- `claimStageRun`
- `updateStageRunThread`
- `consumeIssuePendingLaunchInput`

with:

- `issue_control` for desired stage
- `workspace_ownership` for worktree ownership
- `run_leases` for execution record creation
- `obligations` for pending launch input

The only launch record should be a `run_lease`.

### Step 6: Make completion and failure fully ledger-native

Change:

- [src/service-stage-finalizer.ts](../src/service-stage-finalizer.ts)
- [src/stage-lifecycle-publisher.ts](../src/stage-lifecycle-publisher.ts)
- [src/stage-failure.ts](../src/stage-failure.ts)

so they no longer write:

- `finishStageRun`
- legacy pipeline status
- legacy workspace status
- tracked issue active pointers

Completion and failure should update:

- `run_leases`
- `issue_control`
- `workspace_ownership`
- `run_reports`
- `issue_projection` when useful for UX

### Step 7: Remove legacy adoption and mirror fallback logic

Delete:

- startup adoption of legacy running stages
- mirror lookup fallback during reconciliation
- legacy-first active status fallbacks

At this point, if a record is not in the ledger, PatchRelay does not own it.

### Step 8: Replace workflow ports with ledger and projection ports

Shrink [src/workflow-ports.ts](../src/workflow-ports.ts) drastically or remove it entirely.

Split responsibilities into:

- ledger ports
- projection ports
- artifact ports

This should make it impossible for new code to casually depend on the old workflow model.

### Step 9: Delete the legacy store and schema

Delete:

- [src/db/issue-workflow-store.ts](../src/db/issue-workflow-store.ts)
- legacy workflow types from [src/db-types.ts](../src/db-types.ts)
- legacy table creation from [src/db/migrations.ts](../src/db/migrations.ts)

Drop these tables from SQLite:

- `tracked_issues`
- `workspaces`
- `pipeline_runs`
- `stage_runs`
- `queued_turn_inputs`

After this step, there is no legacy code left.

## Concrete Module Changes

### New modules to add

- `src/db/issue-projection-store.ts`
- `src/db/run-artifact-store.ts`
- `src/projection-ports.ts`
- `src/artifact-ports.ts`

### Modules to rewrite

- [src/service-stage-runner.ts](../src/service-stage-runner.ts)
- [src/service-stage-finalizer.ts](../src/service-stage-finalizer.ts)
- [src/stage-lifecycle-publisher.ts](../src/stage-lifecycle-publisher.ts)
- [src/stage-failure.ts](../src/stage-failure.ts)
- [src/stage-turn-input-dispatcher.ts](../src/stage-turn-input-dispatcher.ts)
- [src/cli/data.ts](../src/cli/data.ts)
- [src/issue-query-service.ts](../src/issue-query-service.ts)
- [src/service.ts](../src/service.ts)

### Modules to delete

- [src/db/issue-workflow-store.ts](../src/db/issue-workflow-store.ts)

### Modules to shrink heavily

- [src/workflow-ports.ts](../src/workflow-ports.ts)
- [src/db-types.ts](../src/db-types.ts)
- [src/db/migrations.ts](../src/db/migrations.ts)

## Testing Requirements For The Final Transition

Before deleting the legacy schema, add or keep tests that prove:

- launch works with no legacy workflow rows present
- restart recovery works with no legacy workflow rows present
- operator input survives restart with only obligations present
- inspect, live, report, and events work from ledger + projection/artifact tables
- completion and failure produce reports without `stage_runs`
- no code path reads `tracked_issues.active_stage_run_id`
- no code path reads `queued_turn_inputs` for correctness

Add one explicit integration test suite that runs PatchRelay against a database containing only the
new tables and proves the full lifecycle:

1. desired stage recorded
2. run lease launched
3. operator input delivered through obligations
4. restart recovery runs
5. completion recorded
6. report and live views remain available

## Definition Of Done

This transition is done only when all of the following are true:

- no runtime code imports or calls `IssueWorkflowStore`
- no runtime path depends on `tracked_issues`, `stage_runs`, `pipeline_runs`, `workspaces`, or
  `queued_turn_inputs`
- active status, inspect, report, and events work without any legacy table present
- launch, completion, failure, and restart recovery use only ledger tables plus projections and
  artifacts
- the legacy schema and store files are deleted

Anything short of that is still hybrid.

## Recommended Execution Shape

Even if this ships as one PR, implement it as these ordered commits:

1. add `issue_projection`, `run_reports`, and `run_thread_events`
2. move reports and thread history to `run_lease_id`
3. move all pending-input handling to `obligations`
4. move operator lookups to `issue_projection`
5. make launch ledger-only
6. make completion/failure ledger-only
7. remove legacy fallback and adoption logic
8. remove workflow ports/store usage
9. delete legacy schema and tests

That is the shortest reasonable path to a codebase with no legacy architecture left in it.
