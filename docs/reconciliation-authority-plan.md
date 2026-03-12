# Reconciliation Authority Cutover Plan

## Goal

Complete the transition from legacy restart logic to a ledger-native recovery harness where:

- `event_receipts`, `issue_control`, `workspace_ownership`, `run_leases`, and `obligations`
  are the authoritative coordination ledger
- live Linear and Codex reads provide current truth
- restart recovery is driven by explicit reconciliation actions
- legacy workflow tables become compatibility/projection layers instead of correctness inputs

## Current State

The current branch already has:

- additive authoritative ledger tables and stores
- a standalone reconciliation engine
- dual-write from webhook intake, desired-stage recording, launch, completion, and failure
- durable obligations for human follow-up
- obligation dedupe enforced by store semantics and a unique index
- ledger-aware startup recovery that checks active `run_leases` before falling back to legacy rows
- obligation replay that clears the matching legacy queued input on successful delivery

The system is still in a bridge state, though:

- startup recovery is still hybrid because `run_leases` fall back to legacy `stage_runs`
- ready-launch seeding still merges ledger-ready `issue_control` with legacy `tracked_issues`
- stage launch still claims and mirrors through legacy workflow rows
- queued turn inputs still participate in operational delivery alongside ledger `obligations`
- CLI/query/report paths still read legacy workflow tables directly

## Immediate Gaps To Close

### 1. Make the ledger the only recovery input

`ServiceRuntime.start()` and `ServiceStageFinalizer.reconcileActiveStageRuns()` should stop using
legacy `tracked_issues` / `stage_runs` as fallback inputs. Reconciliation should be able to run
solely from the authoritative ledger plus live Linear/Codex reads.

### 2. Make the ledger the only launch-intent input

Ready-launch seeding and stage launch should stop consulting legacy `tracked_issues` for desired
stage / desired webhook / active-run ownership.

### 3. Demote compatibility rows without breaking operators

Legacy rows should remain mirrored only long enough for CLI/report/query compatibility. They should
not participate in correctness paths once ledger-native recovery and launch are complete.

## Target End State

PatchRelay should answer these questions after any restart:

1. Which external events have already been accepted?
2. What issue work does the harness currently own?
3. Which run lease is active for that issue?
4. Which obligations are still undelivered?
5. What service-owned external writes must be updated instead of duplicated?
6. Given live Linear and Codex state, what is the next safe action?

The authoritative runtime loop becomes:

1. Read active `run_leases` and launch-ready `issue_control` rows.
2. Hydrate live Linear and Codex state.
3. Run the reconciliation engine.
4. Apply the resulting actions idempotently.
5. Update compatibility/projection tables only as a mirror layer.

## Implementation Phases

### Phase 1: Idempotent obligations

- add a unique index or equivalent store-level upsert semantics for obligation dedupe
- store enough payload to map an obligation back to the matching queued turn input
- when reconciliation delivers an obligation successfully, mark both:
  - the obligation completed
  - the matching queued turn input delivered
- add tests for duplicate comment/prompt delivery and restart replay

### Phase 2: Reconciliation snapshot builder

Add a dedicated builder that assembles reconciliation input from:

- `issue_control`
- the active `run_lease`
- pending `obligations`
- live Linear issue read
- live Codex thread read

This builder should not depend on legacy `tracked_issues` presentation fields or `thread_events`.

### Phase 3: Action applier

Introduce a single action-application layer that can execute the reconciliation engine outputs:

- `launch_desired_stage`
- `keep_run_active`
- `mark_run_completed`
- `mark_run_failed`
- `clear_active_run`
- `release_issue_ownership`
- `sync_linear_failure`
- `refresh_status_comment`
- `route_obligation`
- `deliver_obligation`
- `await_codex_retry`

The action applier becomes the one place where restart recovery mutates the ledger and performs
external side effects.

### Phase 4: Ledger-native startup recovery

Replace the current legacy reconcile loop with:

- `listActiveRunLeases()` as the source of active work
- `listIssueControlsReadyForLaunch()` as the source of desired launches
- reconciliation-engine decisions plus the action applier

Legacy `stage_runs` remain mirrored during this phase for compatibility and reporting, but they no
longer drive startup recovery.

### Phase 5: Ledger-native launch eligibility

Update launch orchestration so the readiness path is based on `issue_control` instead of
`tracked_issues`:

- `ServiceRuntime` seeds work from the ledger-ready issue controls
- `ServiceStageRunner` consumes ledger intent first
- legacy `claimStageRun()` remains as a compatibility mirror until projections are removed

### Phase 6: Demote legacy tables to projections

Once reconciliation and launch eligibility are ledger-native:

- stop using `tracked_issues` as a correctness input
- stop using `stage_runs` as a restart/recovery input
- treat `queued_turn_inputs`, `thread_events`, and stage reports as compatibility/projection data
- retain legacy writes only as long as the CLI/report/query layers still need them

## Remaining Steps

The remaining work is now the full hybrid-removal sequence:

1. Build a canonical ledger reconciliation snapshot builder.
2. Introduce a reconciliation action applier and move startup recovery through it.
3. Remove the legacy `stage_runs` fallback from startup reconciliation.
4. Make launch seeding and launch claiming ledger-native.
5. Make `obligations` the only durable pending-input correctness path.
6. Demote `tracked_issues`, `stage_runs`, and `queued_turn_inputs` to projection status.
7. Update CLI/report/query surfaces to tolerate missing legacy authority.
8. Remove remaining legacy recovery reads and simplify the old stores.

## Proposed PR Sequence

### PR 1: Fix obligation replay and dedupe gaps

- enforce dedupe on obligations
- clear matching legacy queued input on obligation delivery
- add focused restart/idempotency tests

Status: implemented on this branch.

### PR 2: Add ledger reconciliation snapshot and action applier

- build canonical reconciliation input from the ledger
- introduce action execution as a dedicated subsystem
- keep existing recovery loop in place but exercise the action applier in tests

### PR 3: Switch startup recovery from `stage_runs` to `run_leases`

- make `run_leases` the source of active work
- use the reconciliation engine end-to-end during startup
- keep legacy rows mirrored for compatibility

### PR 4: Switch ready-launch seeding from `tracked_issues` to `issue_control`

- seed runtime queues from ledger intent
- make the launch path ledger-first
- keep dual-write to legacy launch rows temporarily

### PR 5: Demote legacy recovery inputs to projections

- remove the old reconcile loop
- narrow remaining legacy reads to CLI/report compatibility
- document the new authoritative runtime model

## Commit-Oriented Execution Plan

To finish the cutover cleanly, use a stacked sequence of narrow commits where each commit leaves the
branch operational and validated.

### Commit A: Canonical reconciliation snapshot builder

Scope:

- add a builder that loads `issue_control`, active `run_leases`, `workspace_ownership`, pending
  `obligations`, and live Linear/Codex state
- normalize the builder output into the reconciliation-engine input shape
- add focused tests for snapshot assembly and edge cases like missing thread IDs or missing live
  Linear data

Expected files:

- `src/reconciliation-snapshot-builder.ts`
- `src/reconciliation-types.ts`
- `src/service-stage-finalizer.ts`
- reconciliation tests

Owner:

- one worker agent focused only on reconciliation input assembly

### Commit B: Reconciliation action applier

Scope:

- introduce a dedicated action-applier module
- map reconciliation outputs to concrete operations:
  - enqueue launch
  - keep run active
  - mark run complete
  - mark run failed
  - clear active ownership
  - deliver obligation
  - refresh service-owned write anchors
- make startup recovery call the applier instead of open-coding the behavior in the finalizer

Expected files:

- `src/reconciliation-action-applier.ts`
- `src/service-stage-finalizer.ts`
- supporting tests

Owner:

- one worker agent focused only on recovery action execution

### Commit C: Remove legacy startup fallback

Scope:

- delete the `stage_runs` fallback path from startup reconciliation
- make `listActiveRunLeases()` the only source of active work at startup
- keep legacy row updates as mirror writes only
- add restart tests proving recovery works with no legacy stage-run reads

Expected files:

- `src/service-stage-finalizer.ts`
- `src/service-runtime.ts`
- restart tests

Owner:

- one worker agent focused on runtime cutover and restart invariants

### Commit D: Ledger-native launch seeding and claiming

Scope:

- make `issue_control` the only readiness input
- move desired-stage and desired-receipt resolution fully into the ledger path
- stop consulting legacy `tracked_issues` to decide whether a run should launch
- keep legacy `claimStageRun()` only as mirror/projection write support until later cleanup

Expected files:

- `src/service.ts`
- `src/service-stage-runner.ts`
- `src/webhook-desired-stage-recorder.ts`
- launch tests

Owner:

- one worker agent focused on ready-queue and launch orchestration

### Commit E: Make obligations the sole durable pending-input path

Scope:

- stop using `queued_turn_inputs` as a correctness dependency
- treat legacy queued inputs as optional mirrored trace rows
- make restart replay and active delivery read only ledger `obligations`
- add tests for comment wake-ups, prompt wake-ups, and restart redelivery with no legacy queue

Expected files:

- `src/stage-turn-input-dispatcher.ts`
- `src/webhook-comment-handler.ts`
- `src/webhook-agent-session-handler.ts`
- `src/service-stage-finalizer.ts`
- obligation delivery tests

Owner:

- one worker agent focused on operator-input delivery only

### Commit F: Demote legacy rows and update read surfaces

Scope:

- narrow CLI/query/report reads so they no longer assume legacy workflow tables are authoritative
- keep compatibility rendering where useful, but tolerate missing legacy authority fields
- document the projection-only role of `tracked_issues`, `stage_runs`, and `queued_turn_inputs`

Expected files:

- `src/cli/data.ts`
- query/report helpers
- docs updates

Owner:

- one worker agent focused on read surfaces and compatibility

### Commit G: Remove dead legacy recovery reads

Scope:

- remove no-longer-used legacy recovery helpers and fallback branches
- simplify stores/interfaces that were only needed for the hybrid phase
- update docs to describe the completed authoritative runtime model

Expected files:

- `src/db/issue-workflow-store.ts`
- `src/service-stage-finalizer.ts`
- `src/service.ts`
- docs

Owner:

- one worker agent focused on cleanup after all previous commits land

## Suggested Agent Choreography

Use a baton-pass sequence rather than asking many agents to edit the same runtime files at once.
The critical-path modules overlap heavily, so parallelism should happen by phase, not by file
conflict.

1. Agent 1 implements Commit A and commits.
2. Agent 2 branches from Agent 1's result, implements Commit B, and commits.
3. Agent 3 branches from Agent 2's result, implements Commit C, and commits.
4. Agent 4 branches from Agent 3's result, implements Commit D, and commits.
5. Agent 1 resumes from Agent 4's result, implements Commit E, and commits.
6. Agent 2 resumes from Agent 5's result, implements Commit F, and commits.
7. Agent 3 resumes from Agent 6's result, implements Commit G, and commits.

At each baton point:

- run `npm run lint`
- run `npm run check`
- run `npm test`
- review the diff before handing the branch to the next agent

This preserves the workflow we already used successfully: each step is a real commit, each commit
keeps the system operational, and the stacked branch converges on full removal of the hybrid model.

## Non-Goals

- no removal of SQLite as the coordination ledger
- no broad CLI/report redesign in the same PRs
- no immediate deletion of compatibility tables before ledger-native runtime is proven

## Acceptance Criteria

- restart correctness depends on the authoritative ledger plus live Linear/Codex reads
- duplicate webhooks/comments/prompts do not create duplicate obligations or duplicate deliveries
- startup recovery no longer begins from `stage_runs`
- ready-launch seeding no longer begins from `tracked_issues`
- legacy workflow tables are compatibility/projection layers, not the source of truth
- `npm run lint`, `npm run check`, and `npm test` pass throughout the migration
