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

The system is still in a bridge state, though:

- startup recovery still starts from legacy `stage_runs`
- ready-launch seeding still starts from legacy `tracked_issues`
- obligation replay does not fully clear the matching legacy queue entry
- obligation dedupe keys are advisory only

## Immediate Gaps To Close

### 1. Make obligation replay idempotent

When an obligation is replayed during reconciliation, PatchRelay must also mark the matching legacy
queued turn input as delivered. Otherwise the same human follow-up can be sent again through the
legacy flush path.

### 2. Enforce obligation dedupe

`obligations.dedupe_key` should be protected by store-level semantics and a database uniqueness
constraint scoped to the active run when appropriate. Duplicate processing of the same webhook or
comment should not create a second obligation.

### 3. Stop treating the ledger as secondary during restart

`ServiceRuntime.start()` and `ServiceStageFinalizer.reconcileActiveStageRuns()` should stop using
legacy `tracked_issues` / `stage_runs` as the starting point for recovery decisions.

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

## Proposed PR Sequence

### PR 1: Fix obligation replay and dedupe gaps

- enforce dedupe on obligations
- clear matching legacy queued input on obligation delivery
- add focused restart/idempotency tests

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
